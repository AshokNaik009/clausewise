import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { decode, ExtensionCodec } from "@msgpack/msgpack";
import { z } from "zod";
import { restoreMessages } from "../session/archives.js";
import type { SessionStore } from "./sessions.js";

const run = promisify(execFile);
const roles: Record<string, string> = { HumanMessage: "human", AIMessage: "ai", SystemMessage: "system", ToolMessage: "tool" };
const rowSchema = z.object({ checkpoint_id: z.string(), type: z.enum(["json", "msgpack"]), payload: z.string().regex(/^[a-f0-9]*$/iu) });

export function decodePythonCheckpoint(type: "json" | "msgpack", bytes: Uint8Array): unknown {
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Python checkpoint exceeds the 16 MiB import limit");
  if (type === "json") return JSON.parse(Buffer.from(bytes).toString("utf8"));
  const codec = new ExtensionCodec();
  let depth = 0;
  const unpack = (data: Uint8Array): unknown => {
    if (++depth > 64) throw new Error("Python checkpoint nesting is excessive");
    try { return decode(data, { extensionCodec: codec, maxStrLength: 16 * 1024 * 1024, maxBinLength: 16 * 1024 * 1024, maxArrayLength: 100_000, maxMapLength: 100_000, maxExtLength: 16 * 1024 * 1024 }); }
    finally { depth--; }
  };
  for (let type = 0; type <= 7; type++) codec.register({ type, encode: () => null, decode: (data) => ({ pythonExtension: type, value: unpack(data) }) });
  return unpack(bytes);
}

export function pythonMessages(checkpoint: unknown) {
  const state = z.object({ channel_values: z.object({ messages: z.array(z.unknown()).max(100_000) }) }).parse(checkpoint);
  const stored = state.channel_values.messages.map((input) => {
    const message = z.record(z.string(), z.unknown()).parse(input);
    if (message.pythonExtension === 4 || message.pythonExtension === 5) {
      const [module, name, fields] = z.tuple([z.string(), z.string(), z.record(z.string(), z.unknown())]).rest(z.unknown()).parse(message.value);
      if (!/^langchain_core\.messages\.(human|ai|system|tool)$/u.test(module) || !Object.hasOwn(roles, name)) throw new Error("Unsupported Python message class; no Python code was executed");
      return { type: roles[name], data: fields };
    }
    if (message.type === "constructor" && (message.lc === 1 || message.lc === 2)) {
      const id = z.array(z.string()).min(2).parse(message.id);
      const name = id.at(-1)!;
      if (!["langchain_core.messages", "langchain.schema.messages"].includes(id.slice(0, -1).join(".")) && !/^langchain_core\.messages\.(human|ai|system|tool)$/u.test(id.slice(0, -1).join("."))) throw new Error("Unsupported Python message namespace");
      if (!Object.hasOwn(roles, name)) throw new Error("Unsupported Python message constructor");
      return { type: roles[name], data: message.kwargs };
    }
    return message.data ? message : { type: message.type, data: message };
  });
  return restoreMessages(stored);
}

export async function readPythonSession(path: string, thread: string) {
  z.string().min(1).max(200).parse(thread);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("Import source must be a regular file of at most 512 MiB");
    const canonical = await realpath(path);
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    if (header.toString("utf8") !== "SQLite format 3\u0000") {
      if (info.size > 16 * 1024 * 1024) throw new Error("JSON checkpoint exceeds 16 MiB");
      const bytes = await handle.readFile();
      return { messages: pythonMessages(decodePythonCheckpoint("json", bytes)), source: canonical, checkpoint: "json-export", thread };
    }
    const quoted = `'${thread.replace(/'/gu, "''")}'`;
    const query = `PRAGMA query_only=ON; SELECT checkpoint_id, type, hex(checkpoint) AS payload FROM checkpoints WHERE thread_id=${quoted} AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1;`;
    const { stdout } = await run("sqlite3", ["-readonly", "-safe", "-json", canonical, query], { timeout: 15_000, maxBuffer: 34 * 1024 * 1024, encoding: "utf8", env: Object.fromEntries(["PATH", "SYSTEMROOT"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])) });
    const rows = z.array(rowSchema).length(1).parse(JSON.parse(stdout || "[]"));
    const row = rows[0]!;
    return { messages: pythonMessages(decodePythonCheckpoint(row.type, Buffer.from(row.payload, "hex"))), source: canonical, checkpoint: row.checkpoint_id, thread };
  } finally { await handle.close(); }
}

export async function importPythonSession(store: SessionStore, source: string, thread: string, options: Parameters<SessionStore["create"]>[0]) {
  const imported = await readPythonSession(source, thread);
  if (!imported.messages.length) throw new Error("Python session has no completed messages to import");
  const { messages, ...provenance } = imported;
  return store.createFromHistory(options, messages, { kind: "python-transcript", ...provenance, limitations: "Conversation-only import. Python graph tasks, pending writes, approvals, extensions, and billing state are not executable in TypeScript and were not imported." });
}
