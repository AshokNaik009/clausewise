import { CodeRuntime } from "../runtime/agent.js";
import type { CodeEvent, RuntimeSettings, ServerCommand, ServerStatus } from "../protocol/index.js";
import { SessionStore, type SessionInfo, type SessionContext } from "../persistence/sessions.js";
import { Configuration } from "../config/configuration.js";
import { CredentialStore } from "../config/credentials.js";
import { ApprovalPolicy } from "../runtime/approval-mode.js";
import { ExtensionHost } from "../extensions/host.js";

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
      });
      try {
        const { settings } = await this.configuration.reload();
        this.extensions = await ExtensionHost.create(context.info.cwd, this.options.trustExtensions === true, settings.projectContext !== false, settings);
        this.runtime = await this.createRuntime(context.info);
        this.info = context.info;
        ready();
        await lifetime;
      } finally {
        try { await this.runtime?.close(); } finally { await this.extensions?.close(); }
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
    this.policy.mode = "manual";
    this.extensions?.configureWeb(effective.settings);
    return CodeRuntime.create({ ...this.context, info }, {
      ...(this.extensions ? { extensions: this.extensions } : {}),
      projectContext: effective.settings.projectContext ?? true,
      shellTimeoutSeconds: effective.settings.shellTimeoutSeconds ?? 120,
      provider: { name, definition, settings: effective.settings },
    });
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
      if (snapshot.settings.projectContext !== previous.snapshot().settings.projectContext) throw new Error("Changing project-context trust requires restarting the session");
      const runtime = await this.createRuntime(this.info);
      await this.runtime.close();
      this.runtime = runtime;
      return snapshot;
    } catch (error) { this.configuration = previous; this.extensions?.configureWeb(previous.snapshot().settings); throw error; }
    finally { this.endMutation(); }
  }

  inventory() {
    if (!this.extensions) throw new Error("Integrations are not initialized");
    return this.extensions.inventory();
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
      }
      const credential = await store.resolve(provider, definition);
      return { provider, endpoint: definition.endpoint, source: credential.source };
    } finally { this.endMutation(); }
  }

  async control(command: Extract<ServerCommand, { method: "controls" | "memory" | "goal" | "goal-update" | "mode" }>) {
    this.assertIdle();
    this.beginMutation();
    try {
      if (!this.runtime?.controls || !this.configuration) throw new Error("Session controls are unavailable");
      if (command.method === "controls") return this.runtime.controls.snapshot();
      if (!(command.method === "mode" && command.mode === "manual") && (await this.runtime.result()).status !== "completed") throw new Error("Finish pending work before changing session controls");
      switch (command.method) {
        case "memory": return await this.runtime.controls.remember(command.text);
        case "goal": return await this.runtime.controls.setGoal(command.objective, command.criteria);
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
    return { session: this.info, mode: this.policy.mode, state, runId: this.active?.id ?? null, result };
  }

  get sessionId(): string {
    if (!this.info) throw new Error("Server session is not initialized");
    return this.info.id;
  }

  async history() {
    if (!this.runtime) throw new Error("Server session is not initialized");
    return this.runtime.history();
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
    const controller = new AbortController();
    const runtime = this.runtime;
    const stream = (event: CodeEvent) => event.type === "result" || event.type === "approval_required" ? Promise.resolve() : onEvent(event);
    const done = (async () => {
      let result = await runtime.turn(command.prompt, { signal: controller.signal, onEvent: stream, ...(command.decisions ? { decisions: command.decisions } : {}) });
      const userRequest = command.prompt ?? (await runtime.history()).filter((message) => message.role === "human").at(-1)?.text ?? "";
      for (let count = 0; result.approvals.length && this.policy.mode !== "manual"; count++) {
        if (count >= 8) { this.policy.mode = "manual"; await onEvent({ type: "policy", mode: "manual", message: "Automatic approval budget reached; review the remaining actions manually." }); break; }
        const decisions = await this.policy.decide(result.approvals, { cwd: this.info!.cwd, userRequest, model: runtime.model, ledger: runtime.ledger, signal: controller.signal });
        controller.signal.throwIfAborted();
        await onEvent({ type: "policy", mode: this.policy.mode, message: decisions ? "Policy approved this action batch." : "Policy requires human review; no action was approved." });
        if (!decisions) break;
        result = await runtime.turn(null, { decisions, signal: controller.signal, onEvent: stream });
      }
      result = await runtime.result();
      if (result.approvals.length) await onEvent({ type: "approval_required", requests: result.approvals });
      await onEvent({ type: "result", result });
      return result;
    })();
    this.active = { id: command.runId, controller, done };
    try { return await done; } finally { this.active = undefined; }
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
