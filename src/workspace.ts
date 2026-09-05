import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { RegCompareError, assert } from "./errors.js";
import { eventSchema, runStateSchema, type Classification, type DocumentRef, type EventRecord, type Profile, type RunState } from "./schemas.js";

export interface RunOptions {
  profile: Profile;
  dataClassification: Classification;
  maxThemes: number;
  concurrency: number;
  agentCallBudget: number;
  agentTimeoutSeconds: number;
  maxSourcePages: number;
  maxSourceChars: number;
  allowPartial: boolean;
  autoApprove: boolean;
  confirmExternalAgentAccess: boolean;
  confirmEncryptedWorkspace: boolean;
  retentionUntil: string | null;
}

export interface Workspace {
  root: string;
  runId: string;
}

export interface RunManifest {
  schema_version: "1.0";
  run_id: string;
  created_at: string;
  profile: Profile;
  options: RunOptions;
  data_classification: Classification;
  documents: DocumentRef[];
  normalization_version: "canon-v1";
}

const privateMode = 0o700;
const privateFileMode = 0o600;
const workspaceDirectories = ["events", "logs", "sources/raw", "sources/normalized", "planning", "context", "reviews", "workers", "quickjs", "audit", "drafts", "scratch"];
const eventQueues = new Map<string, Promise<void>>();

async function serializeWorkspace<T>(workspace: Workspace, operation: () => Promise<T>): Promise<T> {
  const prior = eventQueues.get(workspace.root) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.then(() => current);
  eventQueues.set(workspace.root, queued);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (eventQueues.get(workspace.root) === queued) eventQueues.delete(workspace.root);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyMode(path: string, expected: number): Promise<void> {
  const details = await stat(path);
  if ((details.mode & 0o777) !== expected) throw new RegCompareError("workspace_permissions", `Platform could not enforce mode ${expected.toString(8)} for ${path}.`, 2);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: privateMode });
  await chmod(path, privateMode);
  await verifyMode(path, privateMode);
}

export async function writePrivateFile(path: string, content: string | Buffer): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: privateFileMode, flush: true });
  await chmod(temporaryPath, privateFileMode);
  await rename(temporaryPath, path);
  await chmod(path, privateFileMode);
  await verifyMode(path, privateFileMode);
}

export async function writeImmutableFile(path: string, content: string | Buffer): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, "wx", privateFileMode).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new RegCompareError("immutable_artifact_exists", `Immutable artifact already exists: ${path}`, 3);
    throw error;
  });
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, privateFileMode);
  await verifyMode(path, privateFileMode);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await writeImmutableFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new RegCompareError("invalid_json", `Invalid JSON artifact: ${path}`, 3);
    throw error;
  }
}

export function toArtifactPath(workspace: Workspace, path: string): string {
  const artifactPath = relative(workspace.root, path);
  if (!artifactPath || artifactPath.startsWith("..") || artifactPath.includes("\\") || resolve(path) === workspace.root) {
    throw new RegCompareError("invalid_artifact_path", `Path is outside the run workspace: ${path}`, 3);
  }
  return artifactPath;
}

export function artifactPath(workspace: Workspace, relativePath: string): string {
  const root = resolve(workspace.root);
  const destination = resolve(root, relativePath);
  if (!relativePath || destination === root || !destination.startsWith(`${root}${sep}`)) {
    throw new RegCompareError("path_traversal", `Artifact path escapes the run workspace: ${relativePath}`, 3);
  }
  return destination;
}

async function appendEventRaw(workspace: Workspace, event: EventRecord): Promise<void> {
  const eventName = `${String(event.sequence).padStart(6, "0")}-${event.type}.json`;
  const eventPath = artifactPath(workspace, `events/${eventName}`);
  const line = `${JSON.stringify(event)}\n`;
  await writeImmutableFile(eventPath, line);
  const logPath = artifactPath(workspace, "logs/events.ndjson");
  await appendFile(logPath, line, { mode: privateFileMode, flush: true });
  await chmod(logPath, privateFileMode);
  await verifyMode(logPath, privateFileMode);
}

async function nextEvent(workspace: Workspace, type: EventRecord["type"], actor: EventRecord["actor"], payload: Record<string, unknown>, state: RunState, timestamp = new Date().toISOString()): Promise<EventRecord> {
  const sequence = state.last_event_sequence + 1;
  const previous = sequence > 1 ? await readEvent(workspace, sequence - 1) : null;
  const event = eventSchema.parse({
    schema_version: "1.0",
    run_id: workspace.runId,
    sequence,
    type,
    timestamp,
    actor,
    payload,
    previous_event_sha256: previous ? createHash("sha256").update(JSON.stringify(previous) + "\n").digest("hex") : null,
  });
  await appendEventRaw(workspace, event);
  return event;
}

export async function createWorkspace(root: string, manifest: Omit<RunManifest, "schema_version" | "run_id" | "created_at">): Promise<Workspace> {
  if (await exists(root)) throw new RegCompareError("output_exists", `Output directory already exists: ${root}`, 1);
  process.umask(0o077);
  await ensurePrivateDirectory(root);
  for (const directory of workspaceDirectories) await ensurePrivateDirectory(join(root, directory));
  const workspace = { root: resolve(root), runId: randomUUID() };
  const runManifest: RunManifest = { schema_version: "1.0", run_id: workspace.runId, created_at: new Date().toISOString(), ...manifest };
  await writeImmutableJson(artifactPath(workspace, "manifest.json"), runManifest);
  const createdAt = new Date().toISOString();
  const state = runStateSchema.parse({
    schema_version: "1.0",
    run_id: workspace.runId,
    state: "created",
    updated_at: createdAt,
    active_plan_path: null,
    active_review_stage: null,
    used_agent_calls: 0,
    remaining_agent_calls: manifest.options.agentCallBudget,
    worker_statuses: {},
    final_artifact_paths: [],
    last_event_sequence: 1,
  });
  const event = eventSchema.parse({
    schema_version: "1.0",
    run_id: workspace.runId,
    sequence: 1,
    type: "state_transition",
    timestamp: createdAt,
    actor: "coordinator",
    payload: { from: null, to: "created", state },
    previous_event_sha256: null,
  });
  await appendEventRaw(workspace, event);
  await writeJson(artifactPath(workspace, "run-state.json"), state);
  return workspace;
}

export async function getManifest(workspace: Workspace): Promise<RunManifest> {
  return await readJson<RunManifest>(artifactPath(workspace, "manifest.json"));
}

export async function getState(workspace: Workspace): Promise<RunState> {
  return runStateSchema.parse(await readJson(artifactPath(workspace, "run-state.json")));
}

export async function readEvent(workspace: Workspace, sequence: number): Promise<EventRecord> {
  const directory = artifactPath(workspace, "events");
  const expectedPrefix = `${String(sequence).padStart(6, "0")}-`;
  const entries = await (await import("node:fs/promises")).readdir(directory);
  const name = entries.find((entry) => entry.startsWith(expectedPrefix) && entry.endsWith(".json"));
  if (!name) throw new RegCompareError("ledger_gap", `Event ${sequence} is absent from the run ledger.`, 6);
  return eventSchema.parse(await readJson(join(directory, name)));
}

export async function appendEvent(workspace: Workspace, type: EventRecord["type"], actor: EventRecord["actor"], payload: Record<string, unknown>): Promise<EventRecord> {
  return serializeWorkspace(workspace, async () => {
    const state = await getState(workspace);
    const event = await nextEvent(workspace, type, actor, payload, state);
    await writeJson(artifactPath(workspace, "run-state.json"), runStateSchema.parse({ ...state, updated_at: event.timestamp, last_event_sequence: event.sequence }));
    return event;
  });
}

export async function transitionState(workspace: Workspace, nextState: RunState["state"], patch: Partial<Omit<RunState, "schema_version" | "run_id" | "state" | "updated_at" | "last_event_sequence">> = {}): Promise<RunState> {
  return serializeWorkspace(workspace, async () => {
    const previous = await getState(workspace);
    const timestamp = new Date().toISOString();
    const next = runStateSchema.parse({ ...previous, ...patch, state: nextState, updated_at: timestamp, last_event_sequence: previous.last_event_sequence + 1 });
    await nextEvent(workspace, "state_transition", "coordinator", { from: previous.state, to: nextState, state: next }, previous, timestamp);
    await writeJson(artifactPath(workspace, "run-state.json"), next);
    return next;
  });
}

export async function recordArtifact(workspace: Workspace, artifact: string): Promise<void> {
  await appendEvent(workspace, "artifact_created", "coordinator", { artifact });
}

export async function appendOperationalLog(workspace: Workspace, level: "debug" | "info" | "warn" | "error", stage: string, event: string, message: string, fields: Record<string, unknown> = {}): Promise<void> {
  const log = { timestamp: new Date().toISOString(), level, stage, event, message, fields };
  const path = artifactPath(workspace, "logs/orchestrator.ndjson");
  await appendFile(path, `${JSON.stringify(log)}\n`, { mode: privateFileMode, flush: true });
  await chmod(path, privateFileMode);
  await verifyMode(path, privateFileMode);
}

export async function acquireLock(workspace: Workspace): Promise<void> {
  const path = artifactPath(workspace, "lock");
  const lock = await open(path, "wx", privateFileMode).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new RegCompareError("run_locked", `Run is already active: ${workspace.root}`, 5);
    throw error;
  });
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();
  await chmod(path, privateFileMode);
  await verifyMode(path, privateFileMode);
}

export async function releaseLock(workspace: Workspace): Promise<void> {
  await unlink(artifactPath(workspace, "lock")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function assertWorkspace(path: string): Promise<Workspace> {
  const root = resolve(path);
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new RegCompareError("invalid_run", `Run directory does not exist: ${root}`, 6);
  const manifest = await readJson<RunManifest>(join(root, "manifest.json")).catch(() => null);
  if (!manifest?.run_id) throw new RegCompareError("invalid_run", `Run manifest is missing or invalid: ${root}`, 6);
  return { root, runId: manifest.run_id };
}

export async function validateLedger(workspace: Workspace): Promise<RunState> {
  const manifest = await getManifest(workspace);
  assert(manifest.run_id === workspace.runId, "ledger_run_id", "Manifest run ID does not match the workspace.", 6);
  const entries = (await (await import("node:fs/promises")).readdir(artifactPath(workspace, "events"))).filter((entry) => entry.endsWith(".json")).sort();
  if (!entries.length) throw new RegCompareError("ledger_empty", "Run ledger contains no events.", 6);
  let reconstructed: RunState | null = null;
  let previousHash: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const event = eventSchema.parse(await readJson(join(artifactPath(workspace, "events"), entry)));
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence || !entry.startsWith(`${String(expectedSequence).padStart(6, "0")}-`)) throw new RegCompareError("ledger_sequence", "Run ledger event sequence is not contiguous.", 6);
    if (event.run_id !== workspace.runId || event.previous_event_sha256 !== previousHash) throw new RegCompareError("ledger_chain", "Run ledger hash chain is invalid.", 6);
    previousHash = createHash("sha256").update(JSON.stringify(event) + "\n").digest("hex");
    if (event.type === "state_transition") {
      const payloadState = (event.payload as { state?: unknown }).state;
      reconstructed = runStateSchema.parse(payloadState);
      if (reconstructed.last_event_sequence !== event.sequence || reconstructed.updated_at !== event.timestamp) throw new RegCompareError("ledger_projection", "State-transition event has an invalid projection.", 6);
    } else if (reconstructed) {
      reconstructed = runStateSchema.parse({ ...reconstructed, last_event_sequence: event.sequence, updated_at: event.timestamp });
    }
  }
  if (!reconstructed) throw new RegCompareError("ledger_projection", "Run ledger has no state transition.", 6);
  const current = await getState(workspace);
  if (JSON.stringify(current) !== JSON.stringify(reconstructed)) throw new RegCompareError("corrupt", "run-state.json does not match the immutable event ledger.", 6);
  return current;
}
