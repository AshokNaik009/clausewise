import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checkMessageSize, conversationSchema, PROTOCOL_VERSION, resultSchema, runtimeSettingsSchema, serverMessageSchema, statusSchema, type ClientMessage, type CodeEvent, type RuntimeSettings, type ServerCommand, type ServerStatus } from "../protocol/index.js";
import { sessionSchema } from "../persistence/sessions.js";
import type { TurnOptions } from "../runtime/agent.js";
import { configSnapshotSchema } from "../config/configuration.js";
import { inventorySchema } from "../protocol/extensions.js";
import { controlsSchema, goalUpdateSchema, type ApprovalMode } from "../protocol/session-controls.js";

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  onEvent: ((event: CodeEvent) => void | Promise<void>) | undefined;
  runId: string | undefined;
  rendererError?: Error;
}

export class AgentClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastEventId = 0;
  private dead: Error | undefined;
  private activeRun: string | undefined;
  private closing: Promise<void> | undefined;
  private current: ServerStatus | undefined;

  private constructor() {
    const source = import.meta.url.endsWith(".ts");
    this.child = fork(fileURLToPath(new URL(source ? "../server/main.ts" : "../server/main.js", import.meta.url)), [], {
      execArgv: source ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Agent server startup timed out")); this.child.kill("SIGTERM"); }, 30_000);
      const finish = () => clearTimeout(timer);
      this.child.once("error", (error) => { finish(); reject(error); this.fail(error); });
      this.child.once("exit", (code, signal) => {
        finish();
        const error = new Error(`Agent server exited (${signal ?? code}). Resume explicitly; no tools were automatically replayed.`);
        reject(error);
        this.fail(error);
      });
      this.child.on("message", (raw: unknown) => {
        try {
          checkMessageSize(raw);
          const message = serverMessageSchema.parse(raw);
          if (message.kind === "ready") { finish(); resolve(); return; }
          if (message.kind === "response") {
            const request = this.pending.get(message.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (request.rendererError) request.reject(request.rendererError);
            else if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.data);
            return;
          }
          if (message.eventId <= this.lastEventId) throw new Error("Out-of-order server event");
          this.lastEventId = message.eventId;
          const request = this.pending.get(message.requestId);
          if (!request || request.runId !== message.runId || message.sessionId !== this.current?.session.id) throw new Error("Uncorrelated server event");
          void Promise.resolve().then(() => request.onEvent?.(message.event)).catch((error: unknown) => {
            request.rendererError ??= error instanceof Error ? error : new Error("Event renderer failed");
            void this.cancel().catch(() => undefined);
          }).finally(() => { void this.send({ version: PROTOCOL_VERSION, kind: "ack", eventId: message.eventId }).catch((error: Error) => this.fail(error)); });
        } catch {
          this.fail(new Error("Invalid agent-server protocol message"));
          this.child.kill("SIGTERM");
        }
      });
    });
  }

  static async start(directory: string, sessionId: string, options: Partial<RuntimeSettings> = {}): Promise<AgentClient> {
    const client = new AgentClient();
    try {
      await client.ready;
      client.heartbeat = setInterval(() => { void client.request({ method: "ping" }).catch((error: Error) => { client.fail(error); client.child.kill("SIGTERM"); }); }, 5_000);
      client.current = statusSchema.parse(await client.request({ method: "initialize", directory, sessionId, options: runtimeSettingsSchema.parse(options) }));
      return client;
    } catch (error) { await client.close(); throw error; }
  }

  get session() {
    if (!this.current) throw new Error("Client not initialized");
    return this.current.session;
  }

  get serverPid(): number | undefined { return this.child.pid; }

  private fail(error: Error): void {
    this.dead ??= error;
    clearInterval(this.heartbeat);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  private send(message: ClientMessage): Promise<void> {
    checkMessageSize(message);
    return new Promise((resolve, reject) => {
      if (!this.child.connected) { reject(this.dead ?? new Error("Agent server disconnected")); return; }
      this.child.send(message, (error) => error ? reject(error) : resolve());
    });
  }

  private request(command: ServerCommand, onEvent?: TurnOptions["onEvent"]): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = command.method === "run" || command.method === "compact" || command.method === "cancel" || command.method === "shutdown" ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent server ${command.method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer, onEvent, runId: command.method === "run" ? command.runId : undefined });
      void this.send({ version: PROTOCOL_VERSION, kind: "request", id, command }).catch((error: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async status(): Promise<ServerStatus> {
    this.current = statusSchema.parse(await this.request({ method: "status" }));
    return this.current;
  }

  async configure(reload = false) { return configSnapshotSchema.parse(await this.request({ method: "configure", reload })); }
  async models() { return z.array(z.object({ provider: z.string(), model: z.string() })).parse(await this.request({ method: "models" })); }
  async switchModel(provider: string, model: string) {
    this.current = statusSchema.parse(await this.request({ method: "model", provider, model }));
    return this.current;
  }
  async authenticate(key?: string) { return z.object({ provider: z.string(), endpoint: z.string(), source: z.string() }).parse(await this.request({ method: "auth", ...(key !== undefined ? { key } : {}) })); }
  async inventory() { return inventorySchema.parse(await this.request({ method: "inventory" })); }
  async controls() { return controlsSchema.parse(await this.request({ method: "controls" })); }
  async remember(text: string) { return controlsSchema.parse(await this.request({ method: "memory", text })); }
  async setGoal(objective: string, criteria: string[]) { return controlsSchema.parse(await this.request({ method: "goal", objective, criteria })); }
  async updateGoal(update: z.infer<typeof goalUpdateSchema>) { return controlsSchema.parse(await this.request({ method: "goal-update", update })); }
  async setMode(mode: ApprovalMode, acknowledgement?: string) {
    this.current = statusSchema.parse(await this.request({ method: "mode", mode, ...(acknowledgement ? { acknowledgement } : {}) }));
    return this.current;
  }
  async result() { return (await this.status()).result; }
  async history() { return z.array(conversationSchema).parse(await this.request({ method: "history" })); }
  async sessions() { return z.array(sessionSchema).parse(await this.request({ method: "sessions" })); }
  async select(sessionId: string | null) {
    this.current = statusSchema.parse(await this.request({ method: "select", sessionId }));
    return this.current;
  }

  async turn(prompt: string | null, options: TurnOptions = {}) {
    if (this.activeRun || this.closing) throw new Error("Client is busy or closing");
    options.signal?.throwIfAborted();
    this.activeRun = randomUUID();
    const cancel = () => { void this.cancel().catch(() => undefined); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      return resultSchema.parse(await this.request({ method: "run", runId: this.activeRun, prompt, ...(options.decisions ? { decisions: options.decisions } : {}) }, options.onEvent));
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      this.activeRun = undefined;
    }
  }

  async compact() {
    if (this.activeRun || this.closing) throw new Error("Client is busy or closing");
    this.activeRun = randomUUID();
    try { return z.object({ archive: z.string(), previousMessages: z.number().int(), summary: z.string() }).parse(await this.request({ method: "compact", runId: this.activeRun })); }
    finally { this.activeRun = undefined; }
  }

  async cancel(): Promise<void> { if (this.activeRun) await this.request({ method: "cancel", runId: this.activeRun }); }

  close(): Promise<void> {
    this.closing ??= (async () => {
      clearInterval(this.heartbeat);
      if (!this.dead && this.child.connected) {
        try { await this.request({ method: "shutdown" }); } catch { this.child.kill("SIGTERM"); }
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGTERM");
        await this.exited;
      }
    })();
    return this.closing;
  }
}
