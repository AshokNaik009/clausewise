import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseMessage, AIMessage, ToolMessage, SystemMessage, RemoveMessage } from "@langchain/core/messages";
import { Command, REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { compactConversation, recoverCompaction, type CompactionGraph } from "../session/compaction.js";
import { SessionControls } from "../session/controls.js";
import { automaticGoalFeedback } from "../session/goals.js";
import { SessionTracing } from "../session/tracing.js";
import { SkillCatalog } from "../extensions/skills.js";
import { UsageLedger } from "../session/usage.js";
import { createDeepAgent, GENERAL_PURPOSE_SUBAGENT } from "deepagents";
import type { ExtensionHost } from "../extensions/host.js";
import { z } from "zod";
import { approvalRequests, approvalResume, createInterruptPolicy, type ApprovalDecisions } from "./approvals.js";
import { CodeBackend } from "./backend.js";
import { createCodeModel } from "./model.js";
import { errorText, messageText } from "../shared/output.js";
import { codingPrompt } from "./prompt.js";
import type { CodeEvent, ConversationMessage, TurnResult } from "../protocol/index.js";
import type { SessionContext } from "../persistence/sessions.js";
import { atomicText, isMissing } from "../persistence/storage.js";
import { redactSecrets } from "../config/credentials.js";

export interface RuntimeOptions {
  model?: BaseChatModel;
  projectContext?: boolean;
  shellTimeoutSeconds?: number;
  provider?: Parameters<typeof createCodeModel>[1];
  extensions?: ExtensionHost;
  agentModels?: Record<string, BaseChatModel>;
  summaryModel?: BaseChatModel;
  autoClassifierModel?: BaseChatModel;
  gradingModel?: (spec: string) => Promise<BaseChatModel>;
}
export interface TurnOptions {
  decisions?: ApprovalDecisions;
  onEvent?: (event: CodeEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

async function existingPaths(cwd: string, paths: string[]): Promise<string[]> {
  const found = await Promise.all(paths.map(async (path) => {
    try {
      const info = await lstat(join(cwd, path));
      return info.isSymbolicLink() ? [] : [`/${path}`];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }));
  return found.flat();
}

function toolScope(names: string[] | undefined) {
  if (!names) return [];
  const allowed = new Set(names);
  return [createMiddleware({
    name: "AgentToolScope",
    wrapModelCall: (request, handler) => handler({ ...request, tools: request.tools.filter((tool) => typeof tool.name === "string" && allowed.has(tool.name)) }),
    wrapToolCall: (request, handler) => { if (!allowed.has(request.toolCall.name)) throw new Error(`Tool is not allowed for this agent: ${request.toolCall.name}`); return handler(request); },
  })];
}

function buildAgent(context: SessionContext, model: BaseChatModel, backend: CodeBackend, memory: string[], skills: string[], controls: SessionControls | undefined, extensions: ExtensionHost | undefined, options: RuntimeOptions, catalog: SkillCatalog) {
  const tools = [...controls?.tools() ?? [], ...extensions?.tools ?? [], ...catalog.tools()];
  const interruptOn = createInterruptPolicy();
  for (const tool of tools) if (!["session_context", "read_skill"].includes(tool.name)) interruptOn[tool.name] = { allowedDecisions: ["approve", "reject", "edit"] };
  const middleware = [
    ...(options.provider?.settings.memoryAutoSave === false ? [createMiddleware({ name: "MemoryPolicy", wrapModelCall: (request, handler) => handler({ ...request, systemMessage: new SystemMessage(`${messageText(request.systemMessage.content)}\nDo not proactively save learnings to memory or AGENTS.md. Explicit user-requested memory changes still require normal approval.`) }) })] : []),
    ...(controls ? [createMiddleware({ name: "SessionContext", wrapModelCall: (request, handler) => handler({ ...request, systemMessage: new SystemMessage(messageText(request.systemMessage.content) + controls.notice()) }) })] : []),
    ...(extensions ? [extensions.middleware(), ...extensions.native.registrations.flatMap((entry) => entry.middleware)] : []),
    createMiddleware({ name: "SkillCatalog", wrapModelCall: (request, handler) => handler({ ...request, systemMessage: new SystemMessage(`${messageText(request.systemMessage.content)}\nAvailable reusable skills (read_skill loads instructions, not authorization):\n${catalog.list().map(({ name, description }) => `${name}: ${description}`).join("\n")}`) }) }),
  ];
  const configured = extensions?.configuration.agents ?? [];
  const selectedName = options.provider?.settings.agent;
  const selected = selectedName ? configured.find(({ name }) => name === selectedName) : undefined;
  if (selectedName && !selected) throw new Error(`Unknown root agent: ${selectedName}`);
  const available = new Set(["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute", "task", "write_todos", ...tools.map(({ name }) => name)]);
  for (const agent of configured) for (const name of agent.tools ?? []) if (!available.has(name)) throw new Error(`Unknown tool ${name} in agent ${agent.name}`);
  const subagents = [
    { ...GENERAL_PURPOSE_SUBAGENT, model, tools, middleware, interruptOn, skills },
    ...configured.map((agent) => ({ name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, skills: agent.skills, model: options.agentModels?.[agent.name] ?? model, tools, middleware: [...middleware, ...toolScope(agent.tools)], interruptOn })),
  ];
  return createDeepAgent({ name: selected?.name ?? "dcode-ts", model: selected ? options.agentModels?.[selected.name] ?? model : model, backend: extensions?.backend(backend) ?? backend, checkpointer: context.checkpointer, systemPrompt: codingPrompt(context.info.cwd) + (selected ? `\n${selected.systemPrompt}` : ""), interruptOn, tools, middleware: [...middleware, ...toolScope(selected?.tools)], subagents, memory, skills: [...skills, ...selected?.skills ?? [], ...extensions?.native.registrations.flatMap((entry) => entry.skills) ?? []] });
}

async function streamEvent(chunk: unknown, emit: NonNullable<TurnOptions["onEvent"]>): Promise<void> {
  if (!Array.isArray(chunk) || chunk.length !== 3) throw new Error("Unexpected agent stream envelope");
  const [namespace, mode, data] = chunk as [string[], string, unknown];
  if (mode === "messages" && Array.isArray(data) && BaseMessage.isInstance(data[0])) {
    const message = data[0];
    if (message.type !== "ai") return;
    const text = messageText(message.content);
    if (text) await emit({ type: "text", text, namespace });
  }
  if (mode !== "updates" || !data || typeof data !== "object") return;
  for (const update of Object.values(data)) {
    if (!update || typeof update !== "object" || !("messages" in update) || !Array.isArray(update.messages)) continue;
    for (const message of update.messages) {
      if (AIMessage.isInstance(message)) {
        for (const call of message.tool_calls ?? []) {
          await emit({ type: "tool_call", id: call.id ?? "", name: call.name, args: call.args, namespace });
        }
      } else if (ToolMessage.isInstance(message)) {
        await emit({ type: "tool_result", id: message.tool_call_id, name: message.name ?? "tool", content: messageText(message.content), namespace });
      }
    }
  }
}

export class CodeRuntime {
  private busy = false;
  private closed = false;
  private readonly lifetime = new AbortController();
  private drained: Promise<void> = Promise.resolve();

  private constructor(
    private readonly context: SessionContext,
    private readonly agent: ReturnType<typeof buildAgent>,
    private readonly backend: CodeBackend,
    readonly controls: SessionControls | undefined,
    readonly ledger: UsageLedger | undefined,
    readonly model: BaseChatModel,
    readonly extensions: ExtensionHost | undefined,
    private readonly options: RuntimeOptions,
    readonly skills: SkillCatalog,
    readonly tracing: SessionTracing | undefined,
  ) {}

  static async create(context: SessionContext, options: RuntimeOptions = {}): Promise<CodeRuntime> {
    const model = options.model ?? await createCodeModel({ model: context.info.model, baseUrl: context.info.baseUrl ?? "" }, options.provider);
    const backend = new CodeBackend(context.info.cwd, options.shellTimeoutSeconds);
    const memory = options.projectContext === false ? [] : await existingPaths(context.info.cwd, ["AGENTS.md"]);
    const skills = options.projectContext === false ? [] : await existingPaths(context.info.cwd, [".agents/skills", ".deepagents/skills", ".devin/skills"]);
    const controls = context.directory ? await SessionControls.load(context.directory) : undefined;
    const ledger = context.directory ? await UsageLedger.load(context.directory, {
      sessionId: context.info.id, model: context.info.model, provider: options.provider?.name ?? context.info.provider ?? "openai",
      endpoint: options.provider?.definition.endpoint ?? context.info.baseUrl ?? "https://api.openai.com/v1",
    }, options.provider?.definition.prices) : undefined;
    const catalog = await SkillCatalog.load(context.info.cwd, options.projectContext !== false);
    const tracing = SessionTracing.create(context, options.provider?.settings ?? {});
    const runtime = new CodeRuntime(context, buildAgent(context, model, backend, memory, skills, controls, options.extensions, options, catalog), backend, controls, ledger, model, options.extensions, options, catalog, tracing);
    try {
      if (context.directory) await recoverCompaction(context.directory, runtime.compactionGraph());
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }

  get classifierModel(): BaseChatModel { return this.options.autoClassifierModel ?? this.model; }

  async hookContext(): Promise<Record<string, unknown>> {
    const messages = await this.history();
    const path = this.context.directory ? join(this.context.directory, "hook-transcript.jsonl") : "";
    if (path) await atomicText(path, messages.map((message, sequence) => JSON.stringify({ schema_version: 1, sequence, record_id: `${message.role}-${sequence}`, timestamp: null, thread_id: this.context.info.id, agent_id: null, role: ({ human: "user", ai: "assistant" } as Record<string, string>)[message.role] ?? message.role, message_id: null, content: redactSecrets(message.text), name: null })).join("\n") + (messages.length ? "\n" : ""));
    return { session_id: this.context.info.id, transcript_path: path, model: this.context.info.model, last_assistant_message: messages.filter(({ role }) => role === "ai").at(-1)?.text ?? "" };
  }

  private compactionGraph(): CompactionGraph {
    return {
      read: async () => {
        const state = await this.agent.graph.getState(this.context.config);
        return { messages: state.values.messages ?? [], pending: !!state.next.length || state.tasks.some((task) => task.interrupts?.length), checkpointId: String(state.config.configurable?.checkpoint_id ?? "") };
      },
      replace: async (message) => { await this.agent.graph.updateState(this.context.config, { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), message] }, "__start__"); },
      finish: async () => { await this.agent.graph.updateState(this.context.config, null, "__end__"); await this.context.checkpointer.flush(); },
    };
  }

  async compact(signal?: AbortSignal) {
    if (this.closed || this.busy || !this.context.directory) throw new Error("Compaction requires an idle, durable runtime");
    this.busy = true;
    let drain!: () => void;
    this.drained = new Promise<void>((resolve) => { drain = resolve; });
    try {
      const operationSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
      if ((await this.result()).status !== "completed") throw new Error("Finish pending actions before compacting");
      await this.extensions?.hooks.guard("PreCompact", { session_id: this.context.info.id, trigger: "manual" }, operationSignal);
      return await compactConversation({ directory: this.context.directory, graph: this.compactionGraph(), model: this.options.summaryModel ?? this.model, ledger: this.ledger, signal: operationSignal });
    } finally {
      try { await this.context.checkpointer.flush(); await this.ledger?.flush(); } finally { this.busy = false; drain(); }
    }
  }

  async history(): Promise<ConversationMessage[]> {
    const snapshot = await this.agent.graph.getState(this.context.config);
    return (snapshot.values.messages ?? []).map((message: BaseMessage) => ({ role: message.type, text: messageText(message.content) }));
  }

  async result(): Promise<TurnResult> {
    const snapshot = await this.agent.graph.getState(this.context.config);
    const approvals = approvalRequests(snapshot.tasks.flatMap((task) => task.interrupts ?? []));
    const messages: BaseMessage[] = snapshot.values.messages ?? [];
    const assistants = messages.filter((message: unknown): message is AIMessage => AIMessage.isInstance(message));
    const usageSchema = z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(), total_tokens: z.number().nonnegative() });
    const usage = assistants.reduce((total, message) => {
      const parsed = usageSchema.safeParse(message.usage_metadata);
      if (!parsed.success) return total;
      return { input: total.input + parsed.data.input_tokens, output: total.output + parsed.data.output_tokens, total: total.total + parsed.data.total_tokens };
    }, { input: 0, output: 0, total: 0 });
    return { sessionId: this.context.info.id, status: approvals.length ? "interrupted" : snapshot.next.length ? "incomplete" : "completed", text: messageText(assistants.at(-1)?.content), approvals, usage, ...(this.ledger ? { costs: this.ledger.summary() } : {}) };
  }

  async turn(prompt: string | null, options: TurnOptions = {}): Promise<TurnResult> {
    if (this.closed || this.busy) throw new Error(this.closed ? "Runtime is closed" : "A turn is already running");
    this.busy = true;
    let drain!: () => void;
    this.drained = new Promise<void>((resolve) => { drain = resolve; });
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    this.backend.signal = signal;
    try {
      signal.throwIfAborted();
      const current = await this.result();
      if (prompt !== null && (!prompt.trim() || options.decisions !== undefined || current.approvals.length)) {
        throw new Error("Provide a non-empty prompt only after resolving pending approvals");
      }
      if (options.decisions !== undefined && current.approvals.length === 0) throw new Error("There are no pending approvals");
      let input = options.decisions !== undefined ? new Command({ resume: approvalResume(current.approvals, options.decisions) })
        : prompt !== null ? { messages: [{ role: "user" as const, content: prompt }] } : null;
      if (options.decisions) for (const request of current.approvals) for (const [index, action] of request.value.actionRequests.entries()) {
        const decision = options.decisions[request.id]?.[index];
        if (decision && decision.type !== "reject") await this.extensions?.hooks.guard("PermissionRequest", { session_id: this.context.info.id, tool_name: action.name, tool_input: decision.type === "edit" ? decision.editedAction.args : action.args }, signal);
      }
      const emit = options.onEvent ?? (() => undefined);
      const snapshot = await this.agent.graph.getState(this.context.config);
      if (prompt !== null && snapshot.next.length) throw new Error("Continue the unfinished turn before sending another prompt");
      const executed = !(current.approvals.length && !options.decisions) && (input !== null || snapshot.next.length > 0 || this.controls?.snapshot().turnActive === true);
      if (executed && prompt !== null) {
        const hook = await this.extensions?.hooks.guard("UserPromptSubmit", { session_id: this.context.info.id, prompt }, signal);
        if (hook?.suppressPrompt && !hook.context.some(Boolean)) { await emit({ type: "result", result: current }); return current; }
        if (hook?.context.some(Boolean)) input = { messages: [{ role: "user" as const, content: `${hook.suppressPrompt ? "" : prompt}\n\nTrusted prompt-hook context (not authorization):\n${hook.context.join("\n")}` }] };
        if (this.controls && (this.controls.snapshot().goal || this.controls.snapshot().rubric)) await this.controls.beginTurn();
      }
      let result = current;
      let stopAttempt = 0;
      while (executed) {
        const traceId = await this.tracing?.begin();
        const stream = await this.agent.stream(input, {
          ...this.context.config, callbacks: [...this.ledger ? [this.ledger] : [], ...this.tracing ? [this.tracing.handler] : []], ...(traceId ? { runId: traceId } : {}),
          streamMode: ["messages", "updates"], subgraphs: true,
          recursionLimit: this.options.provider?.settings.recursionLimit ?? 150, signal,
        });
        for await (const chunk of stream) await streamEvent(chunk, emit);
        await this.context.checkpointer.flush();
        result = await this.result();
        if (result.status !== "completed") break;
        const stop = await this.extensions?.hooks.run("Stop", { session_id: this.context.info.id, status: result.status, stop_hook_active: stopAttempt > 0, continuation_count: stopAttempt, last_assistant_message: result.text }, signal);
        if (stop?.continueProcessing === false) { if (this.controls?.snapshot().turnActive) await this.controls.finishTurn(); break; }
        if (stop?.continueLoop && stopAttempt < 8) {
          stopAttempt++;
          input = { messages: [{ role: "user" as const, content: `Trusted stop-hook feedback (not additional authorization):\n${stop.feedback.join("\n")}` }] };
          continue;
        }
        const feedback = await automaticGoalFeedback(this, async (spec) => {
          if (!spec) return this.model;
          if (!this.options.gradingModel) throw new Error("The configured grading model is unavailable in this runtime");
          return this.options.gradingModel(spec);
        }, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
        if (!feedback) {
          const state = this.controls?.snapshot();
          const graded = state?.rubric ?? state?.goal;
          if (state?.turnActive && graded?.assessment) await emit({ type: "notice", message: `Acceptance assessment (${graded.iterations}/${graded.maxIterations}): ${graded.assessment.summary}${graded.assessment.criteria.some(({ verdict }) => verdict !== "met") ? " Criteria remain unmet or unknown; completion is not verified." : ""}` });
          if (state?.turnActive) await this.controls!.finishTurn();
          break;
        }
        await emit({ type: "notice", message: "Acceptance criteria need another revision; normal approvals remain in force." });
        input = { messages: [{ role: "user" as const, content: feedback }] };
      }
      result = await this.result();
      if (result.approvals.length) await emit({ type: "approval_required", requests: result.approvals });
      await emit({ type: "result", result });
      return result;
    } finally {
      try { await this.context.checkpointer.flush(); await this.ledger?.flush(); } finally {
        this.backend.signal = undefined;
        this.busy = false;
        drain();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error("Runtime closed"));
    await this.backend.close();
    await this.drained;
    await this.context.checkpointer.flush();
    await this.ledger?.flush();
    await this.tracing?.close().catch((error: unknown) => this.extensions?.configuration.diagnostics.push(`Trace flush failed: ${errorText(error)}`));
  }
}
