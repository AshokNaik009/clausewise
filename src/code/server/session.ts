import { CodeRuntime } from "../runtime/agent.js";
import type { CodeEvent, RuntimeSettings, ServerCommand, ServerStatus } from "../protocol/index.js";
import { SessionStore, type SessionInfo, type SessionContext } from "../persistence/sessions.js";
import { Configuration } from "../config/configuration.js";
import { CredentialStore } from "../config/credentials.js";
import { ApprovalPolicy } from "../runtime/approval-mode.js";
import { ExtensionHost } from "../extensions/host.js";
import { createCodeModel } from "../runtime/model.js";
import { previewAction } from "../runtime/preview.js";
import { goalWork } from "../session/goals.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export class ServerSession {
  private runtime: CodeRuntime | undefined;
  private readonly policy = new ApprovalPolicy();
  private info: SessionInfo | undefined;
  private release: (() => void) | undefined;
  private lease: Promise<void> | undefined;
  private active: { id: string; controller: AbortController; done: Promise<unknown> } | undefined;
  private mutation = false;
  private mutationDone: Promise<void> = Promise.resolve();
  private finishMutation: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private context: SessionContext | undefined;
  private configuration: Configuration | undefined;
  private extensions: ExtensionHost | undefined;
  private integrationOverrides: Record<string, boolean> = {};
  private integrationReloadRequired = false;

  constructor(private readonly store: SessionStore, private readonly options: RuntimeSettings) {}

  async select(id: string | null): Promise<ServerStatus> {
    this.assertIdle();
    this.beginMutation();
    try {
      const previous = this.info;
      const info = id ? await this.store.get(id) : previous ? await this.store.create({ cwd: previous.cwd, model: previous.model, ...(previous.baseUrl ? { baseUrl: previous.baseUrl } : {}), ...(previous.provider ? { provider: previous.provider } : {}) }) : undefined;
      if (!info) throw new Error("A session must be selected first");
      if (info.id !== previous?.id || !this.runtime) {
        await this.releaseSession();
        await this.acquire(info.id);
      }
      return await this.status();
    } finally { this.endMutation(); }
  }

  private async acquire(id: string): Promise<void> {
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const initialized = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const lifetime = new Promise<void>((resolve) => { this.release = resolve; });
    this.lease = this.store.use(id, async (context) => {
      this.context = context;
      this.configuration = new Configuration(context.info.cwd, {
        ...(this.options.projectContext !== undefined ? { projectContext: this.options.projectContext } : {}),
        ...(this.options.shellTimeoutSeconds !== undefined ? { shellTimeoutSeconds: this.options.shellTimeoutSeconds } : {}),
        ...(this.options.agent ? { agent: this.options.agent } : {}),
        ...(this.options.recursionLimit !== undefined ? { recursionLimit: this.options.recursionLimit } : {}),
      }, this.options.configFile ? { user: this.options.configFile } : undefined);
      try {
        this.configuration.setRuntime(context.info.settings ?? {});
        const { settings } = await this.configuration.reload();
        this.integrationOverrides = {};
        this.extensions = await ExtensionHost.create(context.info.cwd, this.options.trustExtensions === true, settings.projectContext !== false, settings);
        this.runtime = await this.createRuntime(context.info);
        await this.extensions.start(context.info.id, context.info.createdAt === context.info.updatedAt ? "startup" : "resume");
        this.integrationReloadRequired = false;
        this.policy.mode = "manual";
        this.info = context.info;
        ready();
        await lifetime;
      } finally {
        try {
          await this.runtime?.close();
          await this.extensions?.hooks.run("SessionEnd", { session_id: context.info.id, cause: this.closed ? "prompt_input_exit" : "resume" }, undefined);
        } finally { await this.extensions?.close(); }
      }
    });
    void this.lease.catch(failed);
    await initialized;
  }

  private async createRuntime(info: SessionInfo): Promise<CodeRuntime> {
    if (!this.context || !this.configuration) throw new Error("Session is not initialized");
    const effective = this.configuration.snapshot();
    const name = info.provider ?? (info.baseUrl ? "custom" : "openai");
    for (const field of ["model", "provider"] as const) {
      if (effective.provenance[field] === "managed" && effective.settings[field] !== (field === "model" ? info.model : name)) throw new Error(`Session ${field} conflicts with managed policy`);
    }
    const definition = this.configuration.provider(name, info.baseUrl);
    this.extensions?.configureWeb(effective.settings);
    const agentModels: Record<string, BaseChatModel> = {};
    const resolveModel = (selection: { provider: string; model: string }, reasoningEffort?: "low" | "medium" | "high") => {
      const selected = this.configuration!.provider(selection.provider, selection.provider === "custom" ? info.baseUrl : undefined);
      if (effective.provenance.provider === "managed" && selection.provider !== effective.settings.provider) throw new Error("Agent model conflicts with managed provider policy");
      if (effective.provenance.model === "managed" && selection.model !== effective.settings.model) throw new Error("Agent model conflicts with managed model policy");
      if (reasoningEffort && effective.provenance.reasoningEffort === "managed" && reasoningEffort !== effective.settings.reasoningEffort) throw new Error("Agent reasoning effort conflicts with managed policy");
      return createCodeModel({ model: selection.model }, { name: selection.provider, definition: selected, settings: { ...effective.settings, ...(reasoningEffort ? { reasoningEffort } : {}) } });
    };
    for (const agent of this.extensions?.configuration.agents ?? []) if (agent.model || agent.reasoningEffort) agentModels[agent.name] = await resolveModel(agent.model ?? { provider: name, model: info.model }, agent.reasoningEffort);
    const summaryModel = effective.settings.summaryModel ? await resolveModel(effective.settings.summaryModel) : undefined;
    const autoClassifierModel = effective.settings.autoClassifierModel ? await resolveModel(effective.settings.autoClassifierModel) : undefined;
    const runtime = await CodeRuntime.create({ ...this.context, info }, {
      ...(this.extensions ? { extensions: this.extensions } : {}), agentModels, ...(summaryModel ? { summaryModel } : {}), ...(autoClassifierModel ? { autoClassifierModel } : {}),
      gradingModel: (spec) => { const separator = spec.indexOf(":"); return resolveModel({ provider: spec.slice(0, separator), model: spec.slice(separator + 1) }); },
      projectContext: effective.settings.projectContext ?? true,
      shellTimeoutSeconds: effective.settings.shellTimeoutSeconds ?? 120,
      provider: { name, definition, settings: effective.settings },
    });
    if (this.extensions) this.extensions.hooks.prepare = async () => ({ ...await runtime.hookContext(), permission_mode: this.policy.mode === "manual" ? "default" : this.policy.mode === "yolo" ? "bypassPermissions" : "auto" });
    return runtime;
  }

  async configure(reload = false) {
    this.assertIdle();
    if (!this.configuration) throw new Error("Session is not initialized");
    if (!reload) return this.configuration.snapshot();
    this.beginMutation();
    const previous = this.configuration;
    try {
      if (!this.info || !this.runtime || (await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before reloading runtime configuration");
      this.configuration = previous.fork();
      const snapshot = await this.configuration.reload();
      if (snapshot.settings.extensionsEnabled !== previous.snapshot().settings.extensionsEnabled) this.integrationReloadRequired = true;
      if (snapshot.settings.projectContext !== previous.snapshot().settings.projectContext) throw new Error("Changing project-context trust requires restarting the session");
      const runtime = await this.createRuntime(this.info);
      await this.runtime.close();
      this.runtime = runtime;
      this.policy.mode = "manual";
      return snapshot;
    } catch (error) { this.configuration = previous; this.extensions?.configureWeb(previous.snapshot().settings); throw error; }
    finally { this.endMutation(); }
  }

  async settings(scope: "session" | "user", patch: Record<string, unknown>) {
    this.assertIdle();
    this.beginMutation();
    const previous = this.configuration;
    let candidate: CodeRuntime | undefined;
    try {
      if (!previous || !this.info || !this.runtime || !this.context?.saveInfo) throw new Error("Session is not initialized");
      if ((await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before changing settings");
      this.configuration = previous.fork();
      this.configuration.patch(scope, patch);
      if (this.configuration.snapshot().settings.extensionsEnabled !== previous.snapshot().settings.extensionsEnabled) this.integrationReloadRequired = true;
      candidate = await this.createRuntime(this.info);
      if (scope === "user") await this.configuration.persistUser(previous);
      else await this.context.saveInfo({ ...this.info, settings: this.configuration.runtimeSettings(), updatedAt: new Date().toISOString() });
      await this.runtime.close();
      this.runtime = candidate;
      candidate = undefined;
      this.info = this.context.info;
      this.policy.mode = "manual";
      return this.configuration.snapshot();
    } catch (error) {
      await candidate?.close();
      this.configuration = previous;
      if (previous) this.extensions?.configureWeb(previous.snapshot().settings);
      throw error;
    } finally { this.endMutation(); }
  }

  async integrations(action: "reload" | "enable" | "disable", server?: string) {
    this.assertIdle();
    this.beginMutation();
    const previous = this.extensions;
    let candidate: CodeRuntime | undefined;
    try {
      if (!this.info || !this.runtime || !this.configuration || !previous) throw new Error("Session is not initialized");
      if ((await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before rebuilding integrations");
      const overrides = { ...this.integrationOverrides };
      if (action !== "reload") {
        if (!server || !Object.hasOwn(previous.configuration.mcp, server)) throw new Error("Select a configured MCP server");
        overrides[server] = action === "enable";
      }
      const settings = this.configuration.snapshot().settings;
      this.extensions = await ExtensionHost.create(this.info.cwd, this.options.trustExtensions === true, settings.projectContext !== false, settings, overrides);
      await this.extensions.start(this.info.id, "resume");
      candidate = await this.createRuntime(this.info);
      await this.runtime.close();
      this.runtime = candidate;
      candidate = undefined;
      this.integrationOverrides = overrides;
      this.policy.mode = "manual";
      await previous.close();
      this.integrationReloadRequired = false;
      return this.extensions.inventory();
    } catch (error) {
      await candidate?.close();
      if (this.extensions !== previous) await this.extensions?.close();
      this.extensions = previous;
      throw error;
    } finally { this.endMutation(); }
  }

  async plugins(command: Extract<ServerCommand, { method: "plugins" }>) {
    this.assertIdle();
    this.beginMutation();
    try {
      if (!this.runtime || (await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before changing plugins");
      const { PluginMarketplace } = await import("../extensions/marketplace.js");
      const store = new PluginMarketplace();
      if (!["list", "preview", "marketplace-add"].includes(command.action)) this.integrationReloadRequired = true;
      switch (command.action) {
        case "list": return await store.inventory();
        case "preview": {
          const preview = await store.preview(command.argument);
          const { name, version, entry, mcp, hooks, agents } = preview.manifest;
          return { id: preview.id, digest: preview.digest, source: preview.source, manifest: { name, version, entry, mcp: Object.keys(mcp), hooks: hooks.map(({ event }) => event), agents: agents.map(({ name }) => name) } };
        }
        case "marketplace-add": return await store.add(command.argument);
        case "install": if (!command.digest) throw new Error("Review the exact plugin snapshot before installation"); return await store.install(command.argument, command.digest);
        case "enable": if (!this.options.trustExtensions) throw new Error("Restart with --trust-extensions before enabling executable plugins"); return await store.setEnabled(command.argument, true);
        case "disable": return await store.setEnabled(command.argument, false);
        case "uninstall": return await store.uninstall(command.argument);
      }
    } finally { this.endMutation(); }
  }

  async rename(title: string) {
    this.assertIdle();
    this.beginMutation();
    try {
      if (!this.info || !this.context?.saveInfo) throw new Error("Session is not initialized");
      await this.context.saveInfo({ ...this.info, title, updatedAt: new Date().toISOString() });
      return await this.status();
    } finally { this.endMutation(); }
  }

  inventory() {
    if (!this.extensions) throw new Error("Integrations are not initialized");
    return this.extensions.inventory();
  }

  skills() { if (!this.runtime) throw new Error("Session is not initialized"); return this.runtime.skills.list(); }
  skill(name: string, argument: string) { if (!this.runtime) throw new Error("Session is not initialized"); return this.runtime.skills.prompt(name, argument); }
  async trace() { if (!this.runtime?.tracing) throw new Error("Tracing is disabled; explicitly configure tracingEnabled and its endpoint before recording a run"); return this.runtime.tracing.url(); }

  async preview(requestId: string, index: number): Promise<string> {
    this.assertIdle();
    if (!this.runtime || !this.info) throw new Error("Session is not initialized");
    const request = (await this.runtime.result()).approvals.find(({ id }) => id === requestId);
    const action = request?.value.actionRequests[index];
    if (!action) throw new Error("Preview must refer to a pending approval action");
    return previewAction(this.info.cwd, action, this.extensions?.native.registrations.flatMap((entry) => Object.keys(entry.routes)) ?? []);
  }

  models() {
    if (!this.configuration || !this.info) throw new Error("Session is not initialized");
    const configured = Object.entries(this.configuration.providers()).flatMap(([provider, definition]) => definition.models.map((model) => ({ provider, model })));
    return [{ provider: this.info.provider ?? (this.info.baseUrl ? "custom" : "openai"), model: this.info.model }, ...configured];
  }

  async switchModel(provider: string, model: string): Promise<ServerStatus> {
    this.assertIdle();
    this.beginMutation();
    try {
      if (!this.runtime || !this.info || !this.configuration || !this.context?.saveInfo) throw new Error("Session is not initialized");
      const current = await this.runtime.result();
      if (current.status !== "completed") throw new Error("Resolve pending approvals and unfinished work before switching models");
      const definition = this.configuration.provider(provider, provider === "custom" ? this.info.baseUrl : undefined);
      const next = { ...this.info, provider, model, baseUrl: definition.endpoint, updatedAt: new Date().toISOString() };
      const runtime = await this.createRuntime(next);
      try { await this.context.saveInfo(next); } catch (error) { await runtime.close(); throw error; }
      await this.runtime.close();
      this.runtime = runtime;
      this.policy.mode = "manual";
      this.info = this.context.info;
      return await this.status();
    } finally { this.endMutation(); }
  }

  async authenticate(key?: string) {
    this.assertIdle();
    if (!this.info || !this.configuration) throw new Error("Session is not initialized");
    const provider = this.info.provider ?? (this.info.baseUrl ? "custom" : "openai");
    const definition = this.configuration.provider(provider, this.info.baseUrl);
    const store = new CredentialStore();
    this.beginMutation();
    try {
      if (key !== undefined) {
        if (!this.runtime || (await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before changing credentials");
        await store.set(provider, definition.endpoint, key);
        const runtime = await this.createRuntime(this.info);
        await this.runtime.close();
        this.runtime = runtime;
        this.policy.mode = "manual";
      }
      const credential = await store.resolve(provider, definition);
      return { provider, endpoint: definition.endpoint, source: credential.source };
    } finally { this.endMutation(); }
  }

  async control(command: Extract<ServerCommand, { method: "controls" | "memory" | "goal" | "goal-update" | "goal-clear" | "goal-options" | "rubric" | "mode" }>) {
    if (command.method === "mode" && command.mode === "manual") { this.policy.mode = "manual"; return this.status(); }
    if (command.method === "controls" && this.runtime?.controls) return this.runtime.controls.snapshot();
    this.assertIdle();
    this.beginMutation();
    try {
      if (!this.runtime?.controls || !this.configuration) throw new Error("Session controls are unavailable");
      if (command.method === "controls") return this.runtime.controls.snapshot();
      if (!(command.method === "mode" && command.mode === "manual") && (await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before changing session controls");
      switch (command.method) {
        case "goal-clear": return await this.runtime.controls.clearGoal();
        case "memory": return await this.runtime.controls.remember(command.text);
        case "goal": return await this.runtime.controls.setGoal(command.objective, command.criteria, command.revision);
        case "rubric": return await this.runtime.controls.setRubric(command.criteria, command.scope);
        case "goal-options": return command.target === "goal" ? await this.runtime.controls.configureGoal(command.options) : await this.runtime.controls.configureRubric(command.options);
        case "goal-update": return await this.runtime.controls.updateGoal(command.update);
        case "mode":
          this.policy.set(command.mode, command.acknowledgement, this.configuration.snapshot().settings.allowYolo !== false);
          return await this.status();
      }
    } finally { this.endMutation(); }
  }

  private async releaseSession(): Promise<void> {
    this.release?.();
    try { await this.lease; } finally {
      this.runtime = undefined;
      this.release = undefined;
      this.lease = undefined;
    }
  }

  private beginMutation(): void {
    this.mutation = true;
    this.mutationDone = new Promise<void>((resolve) => { this.finishMutation = resolve; });
  }

  private endMutation(): void {
    this.mutation = false;
    this.finishMutation?.();
    this.finishMutation = undefined;
  }

  private assertIdle(): void {
    if (this.closed) throw new Error("Server session is closing");
    if (this.active || this.mutation) throw new Error("Wait for the active operation to finish");
  }

  async status(): Promise<ServerStatus> {
    if (!this.runtime || !this.info) throw new Error("Server session is not initialized");
    const result = await this.runtime.result();
    const state = this.active ? this.active.controller.signal.aborted ? "cancelling" : "running"
      : result.status === "interrupted" ? "awaiting_approval" : result.status === "incomplete" ? "incomplete" : "idle";
    return { session: this.info, options: this.options, mode: this.policy.mode, state, runId: this.active?.id ?? null, result };
  }

  get sessionId(): string {
    if (!this.info) throw new Error("Server session is not initialized");
    return this.info.id;
  }

  async history() {
    if (!this.runtime) throw new Error("Server session is not initialized");
    return this.runtime.history();
  }

  async goalWork(command: Extract<ServerCommand, { method: "goal-work" }>) {
    this.assertIdle();
    if (!this.runtime || !this.configuration || !this.info) throw new Error("Session is not initialized");
    const runtime = this.runtime;
    const configuration = this.configuration;
    const info = this.info;
    const controller = new AbortController();
    const done = (async () => {
      const spec = runtime.controls?.snapshot()[command.target]?.model;
      let model = runtime.model;
      if (spec) {
        const separator = spec.indexOf(":");
        const provider = spec.slice(0, separator);
        const name = spec.slice(separator + 1);
        const effective = configuration.snapshot();
        if ((effective.provenance.provider === "managed" && provider !== effective.settings.provider) || (effective.provenance.model === "managed" && name !== effective.settings.model)) throw new Error("Grading model conflicts with managed policy");
        model = await createCodeModel({ model: name }, { name: provider, definition: configuration.provider(provider, provider === "custom" ? info.baseUrl : undefined), settings: effective.settings });
      }
      return goalWork(runtime, model, command, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
    })();
    this.active = { id: command.runId, controller, done };
    try { return await done; } finally { this.active = undefined; await runtime.ledger?.flush(); }
  }

  async archives(restore?: string) {
    this.assertIdle();
    this.beginMutation();
    try {
      if (!this.context?.directory || !this.info || !this.runtime) throw new Error("Session is not initialized");
      const { listArchives, readArchive } = await import("../session/archives.js");
      if (!restore) return await listArchives(this.context.directory);
      if ((await this.runtime.result()).status !== "completed" || this.runtime.controls?.snapshot().turnActive) throw new Error("Finish pending work before restoring an archive");
      const archive = await readArchive(this.context.directory, restore);
      return await this.store.createFromHistory({ cwd: this.info.cwd, model: this.info.model, ...(this.info.baseUrl ? { baseUrl: this.info.baseUrl } : {}), ...(this.info.provider ? { provider: this.info.provider } : {}) }, archive.restored, { kind: "compaction", sourceSession: this.info.id, archiveId: restore, sourceCheckpoint: archive.checkpointId });
    } finally { this.endMutation(); }
  }

  async compact(runId: string) {
    this.assertIdle();
    if (!this.runtime) throw new Error("Session is not initialized");
    const controller = new AbortController();
    const done = this.runtime.compact(controller.signal);
    this.active = { id: runId, controller, done };
    try { return await done; } finally { this.active = undefined; }
  }

  async run(command: Extract<ServerCommand, { method: "run" }>, onEvent: (event: CodeEvent) => Promise<void>) {
    this.assertIdle();
    if (!this.runtime) throw new Error("Server session is not initialized");
    if (this.integrationReloadRequired) throw new Error("Plugin configuration changed; successfully /plugins reload or restart before running tools");
    const controller = new AbortController();
    const runtime = this.runtime;
    if (this.extensions) {
      this.extensions.hooks.onNotice = (message) => onEvent({ type: "notice", message });
      this.extensions.hooks.onTerminal = (sequence) => this.configuration?.snapshot().settings.terminalEscapes === false ? undefined : onEvent({ type: "terminal", sequence });
    }
    const stream = (event: CodeEvent) => event.type === "result" || event.type === "approval_required" ? Promise.resolve() : onEvent(event);
    const done = (async () => {
      let result = await runtime.turn(command.prompt, { signal: controller.signal, onEvent: stream, ...(command.decisions ? { decisions: command.decisions } : {}) });
      const userRequest = command.prompt ?? (await runtime.history()).filter((message) => message.role === "human").at(-1)?.text ?? "";
      for (let count = 0; result.approvals.length && this.policy.mode !== "manual"; count++) {
        if (count >= 8) { this.policy.mode = "manual"; await onEvent({ type: "policy", mode: "manual", message: "Automatic approval budget reached; review the remaining actions manually." }); break; }
        const decisions = await this.policy.decide(result.approvals, { cwd: this.info!.cwd, userRequest, model: runtime.classifierModel, ledger: runtime.ledger, signal: controller.signal, timeoutSeconds: this.configuration?.snapshot().settings.autoClassifierTimeout ?? 10 });
        controller.signal.throwIfAborted();
        await onEvent({ type: "policy", mode: this.policy.mode, message: decisions ? "Policy approved this action batch." : "Policy requires human review; no action was approved." });
        if (!decisions || !this.policy.automatic) break;
        result = await runtime.turn(null, { decisions, signal: controller.signal, onEvent: stream });
      }
      result = await runtime.result();
      const threshold = this.configuration?.snapshot().settings.sessionCostWarningUsd ?? 50;
      if (threshold > 0 && result.costs && result.costs.knownCostUsd >= threshold && runtime.controls && !runtime.controls.snapshot().costWarningShown) {
        await onEvent({ type: "notice", message: `Known estimated session cost reached $${result.costs.knownCostUsd.toFixed(2)}. Unpriced requests are excluded; this is not a provider invoice.` });
        await runtime.controls.markCostWarning();
      }
      await this.extensions?.hooks.run("Notification", { session_id: this.sessionId, notification_type: result.approvals.length ? "permission_prompt" : "idle_prompt", message: result.status }, controller.signal);
      if (result.approvals.length) await onEvent({ type: "approval_required", requests: result.approvals });
      await onEvent({ type: "result", result });
      return result;
    })();
    this.active = { id: command.runId, controller, done };
    try { return await done; } finally { this.active = undefined; if (this.extensions) { this.extensions.hooks.onNotice = undefined; this.extensions.hooks.onTerminal = undefined; } }
  }

  async wait() {
    await this.active?.done;
    if (!this.runtime) throw new Error("Session is not initialized");
    return this.runtime.result();
  }

  async cancel(id: string): Promise<void> {
    if (this.active?.id !== id) return;
    this.active.controller.abort(new Error("Run cancelled. Continuing can replay uncheckpointed tool effects."));
    await this.active.done.catch(() => undefined);
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      await this.mutationDone;
      if (this.active) await this.cancel(this.active.id);
      await this.releaseSession();
    })();
    return this.closing;
  }
}
