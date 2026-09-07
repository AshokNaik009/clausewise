import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseMessage, AIMessage, ToolMessage, SystemMessage, RemoveMessage } from "@langchain/core/messages";
import { Command, REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { compactConversation, recoverCompaction, type CompactionGraph } from "../session/compaction.js";
import { SessionControls } from "../session/controls.js";
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
import { isMissing } from "../persistence/storage.js";

export interface RuntimeOptions {
  model?: BaseChatModel;
  projectContext?: boolean;
  shellTimeoutSeconds?: number;
  provider?: Parameters<typeof createCodeModel>[1];
  extensions?: ExtensionHost;
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

function buildAgent(context: SessionContext, model: BaseChatModel, backend: CodeBackend, memory: string[], skills: string[], controls: SessionControls | undefined, extensions: ExtensionHost | undefined) {
  const tools = [...controls?.tools() ?? [], ...extensions?.tools ?? []];
  const interruptOn = createInterruptPolicy();
  for (const tool of tools) if (tool.name !== "session_context") interruptOn[tool.name] = { allowedDecisions: ["approve", "reject"] };
  const middleware = [
    ...(controls ? [createMiddleware({
      name: "SessionContext",
      wrapModelCall: (request, handler) => handler({ ...request, systemMessage: new SystemMessage(messageText(request.systemMessage.content) + controls.notice()) }),
    })] : []),
    ...(extensions ? [extensions.middleware()] : []),
  ];
  const subagents = [
    { ...GENERAL_PURPOSE_SUBAGENT, model, tools, middleware, interruptOn, skills },
    ...(extensions?.configuration.agents ?? []).map((agent) => ({ ...agent, model, tools, middleware, interruptOn })),
  ];
  return createDeepAgent({ name: "dcode-ts", model, backend, checkpointer: context.checkpointer, systemPrompt: codingPrompt(context.info.cwd), interruptOn, tools, middleware, subagents, memory, skills });
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
    const runtime = new CodeRuntime(context, buildAgent(context, model, backend, memory, skills, controls, options.extensions), backend, controls, ledger, model, options.extensions);
    try {
      if (context.directory) await recoverCompaction(context.directory, runtime.compactionGraph());
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
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
      await this.extensions?.hooks.run("PreCompact", { session_id: this.context.info.id, trigger: "manual" }, operationSignal);
      return await compactConversation({ directory: this.context.directory, graph: this.compactionGraph(), model: this.model, ledger: this.ledger, signal: operationSignal });
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
      const input = options.decisions !== undefined ? new Command({ resume: approvalResume(current.approvals, options.decisions) })
        : prompt !== null ? { messages: [{ role: "user" as const, content: prompt }] } : null;
      const emit = options.onEvent ?? (() => undefined);
      const snapshot = await this.agent.graph.getState(this.context.config);
      if (prompt !== null && snapshot.next.length) throw new Error("Continue the unfinished turn before sending another prompt");
      const executed = !(current.approvals.length && !options.decisions) && (input !== null || snapshot.next.length > 0);
      if (executed) {
        if (prompt !== null) await this.extensions?.hooks.run("UserPromptSubmit", { session_id: this.context.info.id, prompt }, signal);
        const stream = await this.agent.stream(input, {
          ...this.context.config,
          ...(this.ledger ? { callbacks: [this.ledger] } : {}),
          streamMode: ["messages", "updates"],
          subgraphs: true,
          recursionLimit: 150,
          signal,
        });
        for await (const chunk of stream) await streamEvent(chunk, emit);
      }
      await this.context.checkpointer.flush();
      const result = await this.result();
      if (executed && result.status === "completed" && this.extensions) {
        try { await this.extensions.hooks.run("Stop", { session_id: this.context.info.id, status: result.status }, signal); }
        catch (error) { this.extensions.configuration.diagnostics.push(`Stop hook failed after turn completion: ${errorText(error)}`); }
      }
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
  }
}
