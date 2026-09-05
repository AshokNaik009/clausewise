import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join, normalize, relative } from "node:path";
import { getQuickJS } from "quickjs-emscripten";
import { LIMITS } from "./constants.js";
import { RegCompareError } from "./errors.js";
import type { Workspace } from "./workspace.js";
import { artifactPath, recordArtifact, writeImmutableFile, writeImmutableJson, writePrivateFile } from "./workspace.js";

export type QuickJsCallerRole = "theme_worker" | "evidence_audit";

export interface QuickJsRequest {
  capability: string;
  caller_role: QuickJsCallerRole;
  script: string;
  requested_reads: string[];
  requested_writes: string[];
}

export interface QuickJsExecution {
  execution_id: string;
  timestamp: string;
  caller_role: QuickJsCallerRole;
  theme_id: string | null;
  capability_hash: string;
  allowed_reads: string[];
  allowed_writes: string[];
  script_sha256: string;
  script: string;
  duration_ms: number;
  result: unknown;
  error: string | null;
  resource_outcome: "ok" | "timeout" | "memory_limit" | "stack_limit" | "rejected" | "error";
  written_artifacts: string[];
}

export interface QuickJsCapabilities {
  capability: string;
  callerRole: QuickJsCallerRole;
  themeId: string | null;
  allowedReads: Record<string, string>;
  allowedWrites: string[];
}

export interface QuickJsBroker {
  socketPath: string;
  capabilityFile: string;
  close(): Promise<void>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeOutputPath(path: string): boolean {
  const normalized = normalize(path);
  return normalized !== "." && !normalized.startsWith("..") && !normalized.includes(".." + "/") && !normalized.startsWith("/") && !normalized.includes("\\");
}

function ensureRequest(request: unknown, capabilities: QuickJsCapabilities): asserts request is QuickJsRequest {
  if (!request || typeof request !== "object") throw new RegCompareError("quickjs_invalid_message", "QuickJS request must be an object.", 3);
  const candidate = request as Partial<QuickJsRequest>;
  if (candidate.capability !== capabilities.capability || candidate.caller_role !== capabilities.callerRole) throw new RegCompareError("quickjs_capability_denied", "QuickJS capability is invalid for this caller.", 3);
  if (typeof candidate.script !== "string" || Buffer.byteLength(candidate.script) > LIMITS.quickJsSourceBytes) throw new RegCompareError("quickjs_source_limit", "QuickJS source exceeds the 16 KiB limit.", 3);
  if (!Array.isArray(candidate.requested_reads) || !Array.isArray(candidate.requested_writes) || !candidate.requested_reads.every((value) => typeof value === "string") || !candidate.requested_writes.every((value) => typeof value === "string")) {
    throw new RegCompareError("quickjs_invalid_message", "QuickJS read and write declarations are invalid.", 3);
  }
  if (!candidate.requested_reads.every((path) => Object.hasOwn(capabilities.allowedReads, path))) throw new RegCompareError("quickjs_read_denied", "QuickJS request includes an unapproved artifact read.", 3);
  if (!candidate.requested_writes.every((path) => capabilities.allowedWrites.includes(path) && safeOutputPath(path))) throw new RegCompareError("quickjs_write_denied", "QuickJS request includes an unapproved artifact write.", 3);
}

function jsonArgument(context: { dump(value: unknown): unknown }, value: unknown): unknown {
  return context.dump(value);
}

export async function executeQuickJs(workspace: Workspace, requestValue: unknown, capabilities: QuickJsCapabilities): Promise<QuickJsExecution> {
  const rawMessage = JSON.stringify(requestValue);
  if (Buffer.byteLength(rawMessage) > LIMITS.quickJsMessageBytes) throw new RegCompareError("quickjs_message_limit", "QuickJS RPC message exceeds the 128 KiB limit.", 3);
  ensureRequest(requestValue, capabilities);
  const request = requestValue;
  const executionId = randomUUID();
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();
  const written = new Map<string, string>();
  let readBytes = 0;
  let interrupted = false;
  let result: unknown = null;
  let error: string | null = null;
  let resourceOutcome: QuickJsExecution["resource_outcome"] = "ok";
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.quickJsMemoryBytes);
  runtime.setMaxStackSize(LIMITS.quickJsStackBytes);
  runtime.setInterruptHandler(() => {
    interrupted = Date.now() - startedAt > LIMITS.quickJsTimeoutMs;
    return interrupted;
  });
  const context = runtime.newContext();
  try {
    const listArtifacts = context.newFunction("listArtifacts", (prefixHandle) => {
      const prefix = String(jsonArgument(context, prefixHandle));
      const values = Object.keys(capabilities.allowedReads).filter((path) => path.startsWith(prefix));
      return context.newString(JSON.stringify(values));
    });
    const readArtifact = context.newFunction("readArtifact", (pathHandle) => {
      const path = String(jsonArgument(context, pathHandle));
      if (!request.requested_reads.includes(path) || !Object.hasOwn(capabilities.allowedReads, path)) throw new Error("Artifact read denied");
      const value = capabilities.allowedReads[path] ?? "";
      readBytes += Buffer.byteLength(value);
      if (readBytes > LIMITS.quickJsReadBytes) throw new Error("QuickJS read result limit exceeded");
      return context.newString(value);
    });
    const writeArtifact = context.newFunction("writeArtifact", (pathHandle, contentHandle) => {
      const path = String(jsonArgument(context, pathHandle));
      const content = String(jsonArgument(context, contentHandle));
      if (!request.requested_writes.includes(path) || !capabilities.allowedWrites.includes(path) || !safeOutputPath(path)) throw new Error("Artifact write denied");
      if (Buffer.byteLength(content) > LIMITS.quickJsReadBytes) throw new Error("QuickJS write result limit exceeded");
      written.set(path, content);
      return context.newNumber(1);
    });
    context.setProp(context.global, "listArtifacts", listArtifacts);
    context.setProp(context.global, "readArtifact", readArtifact);
    context.setProp(context.global, "writeArtifact", writeArtifact);
    listArtifacts.dispose();
    readArtifact.dispose();
    writeArtifact.dispose();
    const evaluated = context.evalCode(request.script, `${executionId}.js`);
    if (evaluated.error) {
      error = String(context.dump(evaluated.error));
      evaluated.error.dispose();
      if (interrupted) resourceOutcome = "timeout";
      else if (/memory|allocation|out of memory/iu.test(error)) resourceOutcome = "memory_limit";
      else if (/stack/iu.test(error)) resourceOutcome = "stack_limit";
      else resourceOutcome = "error";
    } else {
      result = context.dump(evaluated.value);
      evaluated.value.dispose();
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    resourceOutcome = interrupted ? "timeout" : /memory|allocation|out of memory/iu.test(error) ? "memory_limit" : /stack/iu.test(error) ? "stack_limit" : "error";
  } finally {
    context.dispose();
    runtime.dispose();
  }
  const outputRoot = artifactPath(workspace, `quickjs/${executionId}/outputs`);
  const writtenArtifacts: string[] = [];
  for (const [path, content] of written) {
    const destination = join(outputRoot, path);
    if (!destination.startsWith(outputRoot + "/")) throw new RegCompareError("quickjs_write_denied", "QuickJS output path escapes its namespace.", 3);
    await writeImmutableFile(destination, content);
    writtenArtifacts.push(relative(workspace.root, destination));
  }
  const execution: QuickJsExecution = {
    execution_id: executionId,
    timestamp,
    caller_role: capabilities.callerRole,
    theme_id: capabilities.themeId,
    capability_hash: digest(capabilities.capability),
    allowed_reads: Object.keys(capabilities.allowedReads).sort(),
    allowed_writes: capabilities.allowedWrites,
    script_sha256: digest(request.script),
    script: request.script,
    duration_ms: Date.now() - startedAt,
    result,
    error,
    resource_outcome: resourceOutcome,
    written_artifacts: writtenArtifacts,
  };
  const artifact = `quickjs/${executionId}.json`;
  await writeImmutableJson(artifactPath(workspace, artifact), execution);
  await recordArtifact(workspace, artifact);
  return execution;
}

function readOneMessage(socketPath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > LIMITS.quickJsMessageBytes) socket.destroy(new Error("QuickJS broker response exceeds limit"));
    });
    socket.on("end", () => resolve(response));
    socket.on("connect", () => socket.end(message));
  });
}

async function closeServer(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function startQuickJsBroker(workspace: Workspace, scratchDirectory: string, capabilities: Omit<QuickJsCapabilities, "capability">): Promise<QuickJsBroker> {
  const nonce = randomBytes(32).toString("hex");
  const socketPath = join(scratchDirectory, `quickjs-${randomUUID()}.sock`);
  const capabilityFile = join(scratchDirectory, `quickjs-${randomUUID()}.cap`);
  await writePrivateFile(capabilityFile, `${nonce}\n`);
  const fullCapabilities: QuickJsCapabilities = { ...capabilities, capability: nonce };
  const server = createServer((socket) => {
    let message = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      message += chunk;
      if (Buffer.byteLength(message) > LIMITS.quickJsMessageBytes) socket.destroy(new Error("QuickJS broker message exceeds limit"));
    });
    socket.on("end", () => {
      void (async () => {
        try {
          const execution = await executeQuickJs(workspace, JSON.parse(message), fullCapabilities);
          socket.end(`${JSON.stringify({ execution_id: execution.execution_id, result: execution.result, error: execution.error, resource_outcome: execution.resource_outcome, written_artifacts: execution.written_artifacts })}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "QuickJS broker rejected the request.";
          socket.end(`${JSON.stringify({ error: message })}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);
  return { socketPath, capabilityFile, close: () => closeServer(server, socketPath) };
}

export async function invokeQuickJsBridge(socketPath: string, capabilityFile: string, callerRole: QuickJsCallerRole, scriptPath: string, requestedReads: string[] = [], requestedWrites: string[] = []): Promise<unknown> {
  const [capability, script] = await Promise.all([readFile(capabilityFile, "utf8"), readFile(scriptPath, "utf8")]);
  const response = await readOneMessage(socketPath, JSON.stringify({ capability: capability.trim(), caller_role: callerRole, script, requested_reads: requestedReads, requested_writes: requestedWrites }));
  return JSON.parse(response);
}
