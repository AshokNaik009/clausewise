import { checkMessageSize, clientMessageSchema, PROTOCOL_VERSION, type ServerCommand, type ServerMessage, type CodeEvent } from "../protocol/index.js";
import { errorText } from "../shared/output.js";
import { ServerSession } from "./session.js";
import { SessionStore } from "../persistence/sessions.js";

if (!process.send) throw new Error("The agent server requires a private parent IPC channel");
let session: ServerSession | undefined;
let store: SessionStore | undefined;
let closing: Promise<void> | undefined;
let initializing = false;
let eventId = 0;
let lastContact = Date.now();
const pending = new Set<Promise<void>>();
const acknowledgements = new Map<number, () => void>();

async function send(message: ServerMessage): Promise<void> {
  checkMessageSize(message);
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error("Client disconnected")); return; }
    process.send(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

async function emit(requestId: string, runId: string, sessionId: string, event: CodeEvent): Promise<void> {
  const id = ++eventId;
  let timer: NodeJS.Timeout | undefined;
  const acknowledged = new Promise<void>((resolve, reject) => {
    acknowledgements.set(id, resolve);
    timer = setTimeout(() => reject(new Error("Client event acknowledgement timed out")), 30_000);
  });
  void acknowledged.catch(() => undefined);
  try {
    await send({ version: PROTOCOL_VERSION, kind: "event", requestId, runId, sessionId, eventId: id, event });
    await acknowledged;
  } finally {
    clearTimeout(timer);
    acknowledgements.delete(id);
    void acknowledged.catch(() => undefined);
  }
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
      return await session.select(command.sessionId);
    } finally { initializing = false; }
  }
  if (!session || !store || initializing) throw new Error("Initialize the server first");
  switch (command.method) {
    case "controls": case "memory": case "goal": case "goal-update": case "mode": return session.control(command);
    case "configure": return session.configure(command.reload);
    case "model": return session.switchModel(command.provider, command.model);
    case "models": return session.models();
    case "inventory": return session.inventory();
    case "auth": return session.authenticate(command.key);
    case "compact": return session.compact(command.runId);
    case "status": return session.status();
    case "history": return session.history();
    case "sessions": return store.list();
    case "select": return session.select(command.sessionId);
    case "cancel": await session.cancel(command.runId); return null;
    case "run": {
      const sessionId = session.sessionId;
      return session.run(command, (event) => emit(id, command.runId, sessionId, event));
    }
    case "shutdown": await session.close(); return null;
  }
}

function stop(): Promise<void> {
  closing ??= (async () => {
    clearInterval(heartbeat);
    for (const resolve of acknowledgements.values()) resolve();
    await session?.close();
    await Promise.allSettled([...pending]);
    await session?.close();
    if (process.connected) process.disconnect();
  })().catch((error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  return closing;
}

const heartbeat = setInterval(() => { if (Date.now() - lastContact > 45_000) void stop(); }, 5_000);
process.on("message", (raw: unknown) => {
  try {
    checkMessageSize(raw);
    const message = clientMessageSchema.parse(raw);
    lastContact = Date.now();
    if (message.kind === "ack") { acknowledgements.get(message.eventId)?.(); return; }
    if (pending.size >= 32) throw new Error("Too many concurrent IPC requests");
    const operation = (async () => {
      try {
        const data = await dispatch(message.id, message.command);
        await send({ version: PROTOCOL_VERSION, kind: "response", id: message.id, data });
      } catch (error) {
        await send({ version: PROTOCOL_VERSION, kind: "response", id: message.id, data: null, error: errorText(error) });
      }
    })();
    pending.add(operation);
    void operation.catch(() => { void stop(); }).finally(() => {
      pending.delete(operation);
      if (message.command.method === "shutdown") void stop();
    });
  } catch { void stop(); }
});
process.once("disconnect", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
await send({ version: PROTOCOL_VERSION, kind: "ready", pid: process.pid });
