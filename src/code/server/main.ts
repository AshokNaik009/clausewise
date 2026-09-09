import { createServer, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, chmod, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMessageSize, clientMessageSchema, PROTOCOL_VERSION, type ServerCommand, type ServerMessage, type CodeEvent } from "../protocol/index.js";
import { connectionPath, helloSchema, receiveFrames, sendFrame, type ConnectionInfo } from "../protocol/transport.js";
import { atomicJson, isMissing } from "../persistence/storage.js";
import { errorText } from "../shared/output.js";
import { ServerSession } from "./session.js";
import { SessionStore } from "../persistence/sessions.js";

if (!process.send) throw new Error("The agent server requires a private bootstrap channel");
const socketDirectory = await mkdtemp(join(tmpdir(), "dct-"));
await chmod(socketDirectory, 0o700);
const connection: ConnectionInfo = { version: 1, id: randomUUID(), pid: process.pid, socket: join(socketDirectory, "agent.sock"), token: randomBytes(32).toString("hex") };
let client: Socket | undefined;
let session: ServerSession | undefined;
let store: SessionStore | undefined;
let closing: Promise<void> | undefined;
let initializing = false;
let eventId = 0;
let lastContact = Date.now();
let descriptor: string | undefined;
let replayBytes = 0;
const events: Extract<ServerMessage, { kind: "event" }>[] = [];
const responses = new Map<string, Extract<ServerMessage, { kind: "response" }>>();
const pending = new Map<string, Promise<void>>();
const acknowledgements = new Map<number, () => void>();
const sockets = new Set<Socket>();

async function send(message: ServerMessage): Promise<void> {
  checkMessageSize(message);
  const socket = client;
  if (!socket || socket.destroyed) return;
  try { await sendFrame(socket, message); } catch { socket.destroy(); }
}

async function emit(requestId: string, runId: string, sessionId: string, event: CodeEvent): Promise<void> {
  const message = { version: PROTOCOL_VERSION, kind: "event", requestId, runId, sessionId, eventId: ++eventId, event } as const;
  checkMessageSize(message);
  events.push(message);
  replayBytes += Buffer.byteLength(JSON.stringify(message));
  while (events.length > 4096 || replayBytes > 16 * 1024 * 1024) replayBytes -= Buffer.byteLength(JSON.stringify(events.shift()!));
  if (!client) return;
  let timer: NodeJS.Timeout | undefined;
  const acknowledged = new Promise<void>((resolve) => {
    acknowledgements.set(eventId, resolve);
    timer = setTimeout(() => { client?.destroy(); resolve(); }, 30_000);
  });
  try { await send(message); await acknowledged; }
  finally { clearTimeout(timer); acknowledgements.delete(message.eventId); }
}

async function dispatch(id: string, command: ServerCommand): Promise<unknown> {
  if (closing) throw new Error("Server is shutting down");
  if (command.method === "ping") return { pid: process.pid };
  if (command.method === "initialize") {
    if (session || initializing) throw new Error("Server already initialized");
    initializing = true;
    try {
      store = new SessionStore(command.directory);
      session = new ServerSession(store, command.options);
      const status = await session.select(command.sessionId);
      descriptor = connectionPath(store.directory, connection.id);
      await atomicJson(descriptor, connection);
      return status;
    } finally { initializing = false; }
  }
  if (!session || !store || initializing) throw new Error("Initialize the server first");
  switch (command.method) {
    case "controls": case "memory": case "goal": case "goal-update": case "goal-clear": case "goal-options": case "rubric": case "mode": return session.control(command);
    case "settings": return session.settings(command.scope, command.patch);
    case "rename": return session.rename(command.title);
    case "integrations": return session.integrations(command.action, command.server);
    case "plugins": return session.plugins(command);
    case "configure": return session.configure(command.reload);
    case "model": return session.switchModel(command.provider, command.model);
    case "models": return session.models();
    case "inventory": return session.inventory();
    case "skills": return session.skills();
    case "skill": return session.skill(command.name, command.argument);
    case "trace": return session.trace();
    case "preview": return session.preview(command.requestId, command.action);
    case "auth": return session.authenticate(command.key);
    case "compact": return session.compact(command.runId);
    case "archives": return session.archives(command.restore);
    case "goal-work": return session.goalWork(command);
    case "status": return session.status();
    case "wait": return session.wait();
    case "history": return session.history();
    case "sessions": return store.list();
    case "select": return session.select(command.sessionId);
    case "cancel": await session.cancel(command.runId); return null;
    case "run": return session.run(command, (event) => emit(id, command.runId, session!.sessionId, event));
    case "shutdown": await session.close(); return null;
  }
}

function stop(): Promise<void> {
  closing ??= (async () => {
    clearInterval(heartbeat);
    for (const resolve of acknowledgements.values()) resolve();
    await session?.close();
    await Promise.allSettled([...pending.values()]);
    await session?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (descriptor) await unlink(descriptor).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    await rmdir(socketDirectory);
    if (process.connected) process.disconnect();
  })().catch((error: unknown) => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
  return closing;
}

function request(raw: unknown): void {
  const message = clientMessageSchema.parse(raw);
  lastContact = Date.now();
  if (message.kind === "ack") { acknowledgements.get(message.eventId)?.(); return; }
  const previous = responses.get(message.id);
  if (previous) { void send(previous); return; }
  if (pending.has(message.id)) return;
  if (pending.size >= 32) throw new Error("Too many concurrent requests");
  const operation = (async () => {
    let response: Extract<ServerMessage, { kind: "response" }>;
    try { response = { version: PROTOCOL_VERSION, kind: "response", id: message.id, data: await dispatch(message.id, message.command) }; }
    catch (error) { response = { version: PROTOCOL_VERSION, kind: "response", id: message.id, data: null, error: errorText(error) }; }
    try { checkMessageSize(response); } catch { response = { version: PROTOCOL_VERSION, kind: "response", id: message.id, data: null, error: "Response exceeds 4 MiB; use a smaller query" }; }
    responses.set(message.id, response);
    let size = 0;
    for (const [id, value] of [...responses].reverse()) {
      size += Buffer.byteLength(JSON.stringify(value));
      if (responses.size > 128 || size > 16 * 1024 * 1024) responses.delete(id);
    }
    await send(response);
  })();
  pending.set(message.id, operation);
  void operation.finally(() => { pending.delete(message.id); if (message.command.method === "shutdown") void stop(); }).catch(() => { void stop(); });
}

const server = createServer((socket) => {
  sockets.add(socket);
  let authenticated = false;
  const timeout = setTimeout(() => socket.destroy(), 5000);
  socket.on("error", () => undefined);
  socket.once("close", () => {
    clearTimeout(timeout);
    sockets.delete(socket);
    if (client === socket) {
      client = undefined;
      lastContact = Date.now();
      for (const resolve of acknowledgements.values()) resolve();
    }
  });
  receiveFrames(socket, (raw) => {
    try {
      if (authenticated) { request(raw); return; }
      const hello = helloSchema.parse(raw);
      if (client || closing || hello.token.length !== connection.token.length || !timingSafeEqual(Buffer.from(hello.token), Buffer.from(connection.token))) throw new Error("Connection refused");
      authenticated = true;
      clearTimeout(timeout);
      client = socket;
      lastContact = Date.now();
      const oldest = events[0]?.eventId ?? eventId + 1;
      void send({ version: PROTOCOL_VERSION, kind: "ready", pid: process.pid, oldestEventId: oldest, latestEventId: eventId });
      if (hello.after < oldest - 1) void send({ version: PROTOCOL_VERSION, kind: "gap", eventId: oldest - 1, message: "Some display events expired from the replay buffer. Read /history for durable conversation; no tools were replayed." });
      for (const event of events) if (event.eventId > hello.after) void send(event);
      for (const id of hello.pending) {
        const response = responses.get(id);
        if (response) void send(response);
        else if (!pending.has(id)) void send({ version: PROTOCOL_VERSION, kind: "response", id, data: null, error: "Request outcome unavailable. Inspect session state; the request was not automatically resent." });
      }
    } catch { socket.destroy(); }
  });
});
const heartbeat = setInterval(() => {
  if (client && Date.now() - lastContact > 45_000) client.destroy();
  if (!client && Date.now() - lastContact > (session ? 15 * 60_000 : 30_000)) void stop();
}, 5000);
process.once("disconnect", () => { if (!session) void stop(); });
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(connection.socket, resolve); });
await chmod(connection.socket, 0o600);
process.send(connection);
