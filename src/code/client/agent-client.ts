import { fork, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { checkMessageSize, conversationSchema, PROTOCOL_VERSION, resultSchema, runtimeSettingsSchema, serverMessageSchema, statusSchema, type CodeEvent, type RuntimeSettings, type ServerCommand, type ServerMessage, type ServerStatus } from "../protocol/index.js";
import { connectionSchema, readConnection, receiveFrames, sendFrame, type ConnectionInfo } from "../protocol/transport.js";
import { sessionSchema } from "../persistence/sessions.js";
import type { TurnOptions } from "../runtime/agent.js";
import { configSnapshotSchema } from "../config/configuration.js";
import { inventorySchema } from "../protocol/extensions.js";
import { assessmentSchema, controlsSchema, goalProposalSchema, goalUpdateSchema, type ApprovalMode } from "../protocol/session-controls.js";
import { skillInfoSchema } from "../extensions/skills.js";

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  onEvent: TurnOptions["onEvent"];
  runId: string | undefined;
  rendererError?: Error;
}

export class AgentClient {
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcess | undefined;
  private socket: Socket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastEventId = 0;
  private dead: Error | undefined;
  private activeRun: string | undefined;
  private closing: Promise<void> | undefined;
  private detached = false;
  private current: ServerStatus | undefined;
  private connecting: Promise<void> | undefined;
  private received: Promise<void> = Promise.resolve();
  private readonly observers = new Set<(event: CodeEvent) => void>();
  private readonly notices = new Set<(message: string) => void>();
  private backlog: CodeEvent[] = [];
  private backlogBytes = 0;
  private connectionState: "connected" | "reconnecting" | "disconnected" = "disconnected";

  private constructor(private readonly connection: ConnectionInfo, readonly directory: string) {}

  static async start(directory: string, sessionId: string, options: Partial<RuntimeSettings> = {}): Promise<AgentClient> {
    const source = import.meta.url.endsWith(".ts");
    const child = fork(fileURLToPath(new URL(source ? "../server/main.ts" : "../server/main.js", import.meta.url)), [], {
      execArgv: source ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json", detached: true,
    });
    let client: AgentClient | undefined;
    try {
      const connection = await new Promise<ConnectionInfo>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Agent server startup timed out")), 30_000);
        child.once("message", (raw) => { clearTimeout(timer); try { resolve(connectionSchema.parse(raw)); } catch { reject(new Error("Invalid server bootstrap")); } });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Agent server exited during startup")); });
      });
      client = new AgentClient(connection, directory);
      client.child = child;
      await client.connect();
      client.current = statusSchema.parse(await client.request({ method: "initialize", directory, sessionId, options: runtimeSettingsSchema.parse(options) }));
      client.startHeartbeat();
      if (child.connected) child.disconnect();
      return client;
    } catch (error) { if (client) await client.close(); else child.kill("SIGTERM"); throw error; }
  }

  static async attach(directory: string, serverId: string): Promise<AgentClient> {
    const client = new AgentClient(await readConnection(directory, serverId), directory);
    try { await client.connect(); await client.status(); client.startHeartbeat(); return client; }
    catch (error) { await client.detach(); throw error; }
  }

  get session() { if (!this.current) throw new Error("Client not initialized"); return this.current.session; }
  get serverPid(): number { return this.connection.pid; }
  get serverId(): string { return this.connection.id; }
  get state() { return this.connectionState; }
  get isDetached() { return this.detached; }

  subscribe(onEvent: (event: CodeEvent) => void, onNotice?: (message: string) => void): () => void {
    this.observers.add(onEvent);
    if (onNotice) this.notices.add(onNotice);
    for (const event of this.backlog) onEvent(event);
    this.backlog = [];
    this.backlogBytes = 0;
    return () => { this.observers.delete(onEvent); if (onNotice) this.notices.delete(onNotice); };
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.connectionState === "connected") void this.request({ method: "ping" }).catch(() => this.socket?.destroy());
    }, 5000);
  }

  private fail(error: Error): void {
    this.dead ??= error;
    this.connectionState = "disconnected";
    clearInterval(this.heartbeat);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    for (const notice of this.notices) notice(error.message);
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.connection.socket);
      this.socket = socket;
      let ready = false;
      const timer = setTimeout(() => socket.destroy(new Error("Server connection timed out")), 5000);
      socket.once("connect", () => {
        void sendFrame(socket, { kind: "hello", token: this.connection.token, after: this.lastEventId, pending: [...this.pending.keys()] }).catch((error: Error) => socket.destroy(error));
      });
      socket.on("error", () => undefined);
      socket.once("close", () => {
        clearTimeout(timer);
        if (!ready) reject(new Error("Cannot attach: server unavailable or another client is connected"));
        if (this.closing) this.fail(new Error("Server disconnected during shutdown"));
        else if (ready && !this.detached && !this.dead) void this.reconnect().catch((error: Error) => this.fail(error));
      });
      receiveFrames(socket, (raw) => {
        try {
          const message = serverMessageSchema.parse(raw);
          if (message.kind === "ready") { ready = true; clearTimeout(timer); this.connectionState = "connected"; resolve(); return; }
          this.received = this.received.then(() => this.receive(message, socket)).catch(() => { this.fail(new Error("Invalid server event or failed event renderer")); socket.destroy(); });
        } catch { socket.destroy(new Error("Invalid server protocol message")); }
      });
    });
  }

  private async receive(message: Exclude<ServerMessage, { kind: "ready" }>, socket: Socket): Promise<void> {
    if (message.kind === "gap") {
      this.lastEventId = Math.max(this.lastEventId, message.eventId);
      for (const notice of this.notices) notice(message.message);
      return;
    }
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
    if (message.eventId > this.lastEventId) {
      const request = this.pending.get(message.requestId);
      if (request && request.runId !== message.runId) throw new Error("Uncorrelated run event");
      try {
        await request?.onEvent?.(message.event);
        for (const observer of this.observers) observer(message.event);
        if (!request?.onEvent && !this.observers.size) {
          this.backlog.push(message.event);
          this.backlogBytes += Buffer.byteLength(JSON.stringify(message.event));
          while (this.backlog.length > 4096 || this.backlogBytes > 16 * 1024 * 1024) this.backlogBytes -= Buffer.byteLength(JSON.stringify(this.backlog.shift()!));
        }
      } catch (error) {
        if (request) request.rendererError = error instanceof Error ? error : new Error("Event renderer failed");
        void this.cancel().catch(() => undefined);
      }
      this.lastEventId = message.eventId;
    }
    await sendFrame(socket, { version: PROTOCOL_VERSION, kind: "ack", eventId: message.eventId }).catch(() => undefined);
  }

  reconnect(): Promise<void> {
    if (this.connectionState === "connected" && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.closing || this.detached || this.dead) return Promise.reject(this.dead ?? new Error("Client closed"));
    this.connecting ??= (async () => {
      this.connectionState = "reconnecting";
      for (const notice of this.notices) notice("Reconnecting to the existing server; no requests will be resent.");
      for (let attempt = 0; attempt < 8; attempt++) {
        await delay(Math.min(250 * 2 ** attempt, 3000));
        if (this.closing || this.detached) return;
        try { await this.connect(); return; } catch { this.connectionState = "reconnecting"; }
      }
      throw new Error("Server reconnect failed. Attach again or explicitly resume the saved session; tools were not replayed.");
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async request(command: ServerCommand, onEvent?: TurnOptions["onEvent"]): Promise<unknown> {
    if (this.dead || this.detached) throw this.dead ?? new Error("Client detached");
    if (this.connecting) await this.connecting;
    if (!this.socket || this.socket.destroyed) throw new Error("Server disconnected");
    const id = randomUUID();
    const message = { version: PROTOCOL_VERSION, kind: "request", id, command } as const;
    checkMessageSize(message);
    return new Promise((resolve, reject) => {
      const timer = ["run", "compact", "goal-work", "wait", "cancel", "shutdown"].includes(command.method) ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent server ${command.method} timed out; inspect state before retrying`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer, onEvent, runId: command.method === "run" ? command.runId : undefined });
      void sendFrame(this.socket!, message).catch(() => { this.socket?.destroy(); });
    });
  }

  async status(): Promise<ServerStatus> { this.current = statusSchema.parse(await this.request({ method: "status" })); return this.current; }
  async configure(reload = false) { return configSnapshotSchema.parse(await this.request({ method: "configure", reload })); }
  async settings(patch: Record<string, unknown>, scope: "session" | "user" = "session") { return configSnapshotSchema.parse(await this.request({ method: "settings", scope, patch })); }
  async rename(title: string) { this.current = statusSchema.parse(await this.request({ method: "rename", title })); return this.current; }
  async clearGoal() { return controlsSchema.parse(await this.request({ method: "goal-clear" })); }
  async integrations(action: "reload" | "enable" | "disable", server?: string) { return inventorySchema.parse(await this.request({ method: "integrations", action, ...(server ? { server } : {}) })); }
  async models() { return z.array(z.object({ provider: z.string(), model: z.string() })).parse(await this.request({ method: "models" })); }
  async switchModel(provider: string, model: string) { this.current = statusSchema.parse(await this.request({ method: "model", provider, model })); return this.current; }
  async authenticate(key?: string) { return z.object({ provider: z.string(), endpoint: z.string(), source: z.string() }).parse(await this.request({ method: "auth", ...(key !== undefined ? { key } : {}) })); }
  async plugins(action: "list" | "marketplace-add" | "preview" | "install" | "enable" | "disable" | "uninstall", argument = "", digest?: string) { return this.request({ method: "plugins", action, argument, ...(digest ? { digest } : {}) }); }
  async pluginPreview(id: string) { return z.object({ id: z.string(), digest: z.string(), source: z.string(), manifest: z.object({ name: z.string(), version: z.string() }).passthrough() }).parse(await this.plugins("preview", id)); }
  async inventory() { return inventorySchema.parse(await this.request({ method: "inventory" })); }
  async preview(requestId: string, action: number) { return z.string().parse(await this.request({ method: "preview", requestId, action })); }
  async controls() { return controlsSchema.parse(await this.request({ method: "controls" })); }
  async remember(text: string) { return controlsSchema.parse(await this.request({ method: "memory", text })); }
  async setGoal(objective: string, criteria: string[], revision?: number) { return controlsSchema.parse(await this.request({ method: "goal", objective, criteria, ...(revision !== undefined ? { revision } : {}) })); }
  async setRubric(criteria: string[] | null, scope: "session" | "next" = "session") { return controlsSchema.parse(await this.request({ method: "rubric", criteria, scope })); }
  async goalOptions(target: "goal" | "rubric", options: { model?: string | null; maxIterations?: number }) { return controlsSchema.parse(await this.request({ method: "goal-options", target, options })); }
  async goalWork(target: "goal" | "rubric", action: "draft" | "amend" | "grade", text = "") {
    if (this.activeRun || this.closing) throw new Error("Client is busy or closing");
    this.activeRun = randomUUID();
    try { return z.object({ proposal: goalProposalSchema.optional(), assessment: assessmentSchema.optional(), revision: z.number().optional(), limitations: z.string().optional() }).parse(await this.request({ method: "goal-work", runId: this.activeRun, target, action, text })); }
    finally { this.activeRun = undefined; }
  }
  async skills() { return z.array(skillInfoSchema).parse(await this.request({ method: "skills" })); }
  async skill(name: string, argument: string) { return z.string().parse(await this.request({ method: "skill", name, argument })); }
  async trace() { return z.string().url().parse(await this.request({ method: "trace" })); }
  async updateGoal(update: z.infer<typeof goalUpdateSchema>) { return controlsSchema.parse(await this.request({ method: "goal-update", update })); }
  async setMode(mode: ApprovalMode, acknowledgement?: string) { this.current = statusSchema.parse(await this.request({ method: "mode", mode, ...(acknowledgement ? { acknowledgement } : {}) })); return this.current; }
  async result() { return (await this.status()).result; }
  async history() { return z.array(conversationSchema).parse(await this.request({ method: "history" })); }
  async sessions() { return z.array(sessionSchema).parse(await this.request({ method: "sessions" })); }
  async select(sessionId: string | null) { this.current = statusSchema.parse(await this.request({ method: "select", sessionId })); return this.current; }
  async wait() { return resultSchema.parse(await this.request({ method: "wait" })); }

  async turn(prompt: string | null, options: TurnOptions = {}) {
    if (this.activeRun || this.closing) throw new Error("Client is busy or closing");
    options.signal?.throwIfAborted();
    this.activeRun = randomUUID();
    const cancel = () => { void this.cancel().catch(() => undefined); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try { return resultSchema.parse(await this.request({ method: "run", runId: this.activeRun, prompt, ...(options.decisions ? { decisions: options.decisions } : {}) }, options.onEvent)); }
    finally { options.signal?.removeEventListener("abort", cancel); this.activeRun = undefined; }
  }

  async archives() { const { archiveInfoSchema } = await import("../session/archives.js"); return z.array(archiveInfoSchema).parse(await this.request({ method: "archives" })); }
  async restoreArchive(id: string) { return sessionSchema.parse(await this.request({ method: "archives", restore: id })); }

  async compact() {
    if (this.activeRun || this.closing) throw new Error("Client is busy or closing");
    this.activeRun = randomUUID();
    try { return z.object({ archive: z.string(), previousMessages: z.number().int(), summary: z.string() }).parse(await this.request({ method: "compact", runId: this.activeRun })); }
    finally { this.activeRun = undefined; }
  }

  async cancel(): Promise<void> {
    const runId = this.activeRun ?? (await this.status()).runId;
    if (runId) await this.request({ method: "cancel", runId });
  }

  async detach(): Promise<void> {
    this.detached = true;
    clearInterval(this.heartbeat);
    const socket = this.socket;
    if (socket && !socket.destroyed) await new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); });
    this.child?.unref();
    this.fail(new Error("Client detached; server will expire after 15 minutes without a client"));
  }

  close(): Promise<void> {
    if (this.detached) return Promise.resolve();
    this.closing ??= (async () => {
      clearInterval(this.heartbeat);
      if (!this.dead && this.socket && !this.socket.destroyed) {
        try { await this.request({ method: "shutdown" }); } catch { this.child?.kill("SIGTERM"); }
      } else this.child?.kill("SIGTERM");
      this.socket?.destroy();
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) await new Promise<void>((resolve) => this.child!.once("exit", () => resolve()));
      this.fail(new Error("Client closed"));
    })();
    return this.closing;
  }
}
