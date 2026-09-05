import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { RegCompareError } from "./errors.js";
import { runStateSchema, type Classification, type DocumentRef, type Profile, type RunState } from "./schemas.js";

export interface RunOptions {
  profile: Profile;
  dataClassification: Classification;
  maxThemes: number;
  concurrency: number;
  agentCallBudget: number;
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

interface EventRecord {
  schema_version: "1.0";
  run_id: string;
  sequence: number;
  type: string;
  timestamp: string;
  actor: "coordinator" | "reviewer" | "worker";
  payload: Record<string, unknown>;
  previous_event_sha256: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivateFile(path: string, content: string | Buffer): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function toArtifactPath(workspace: Workspace, path: string): string {
  const artifactPath = relative(workspace.root, path);
  if (!artifactPath || artifactPath.startsWith("..") || artifactPath.includes("\\")) {
    throw new RegCompareError("invalid_artifact_path", `Path is outside the run workspace: ${path}`, 3);
  }
  return artifactPath;
}

export function artifactPath(workspace: Workspace, relativePath: string): string {
  const destination = resolve(workspace.root, relativePath);
  if (!destination.startsWith(`${resolve(workspace.root)}/`)) {
    throw new RegCompareError("path_traversal", `Artifact path escapes the run workspace: ${relativePath}`, 3);
  }
  return destination;
}

export async function createWorkspace(root: string, manifest: Omit<RunManifest, "schema_version" | "run_id" | "created_at">): Promise<Workspace> {
  if (await exists(root)) throw new RegCompareError("output_exists", `Output directory already exists: ${root}`, 1);
  await ensurePrivateDirectory(root);
  for (const directory of ["events", "logs", "sources/raw", "sources/normalized", "planning", "context", "reviews", "workers", "quickjs", "audit", "drafts", "scratch"]) {
    await ensurePrivateDirectory(join(root, directory));
  }
  const workspace = { root: resolve(root), runId: randomUUID() };
  const runManifest: RunManifest = { schema_version: "1.0", run_id: workspace.runId, created_at: new Date().toISOString(), ...manifest };
  await writeJson(artifactPath(workspace, "manifest.json"), runManifest);
  const state: RunState = {
    schema_version: "1.0",
    run_id: workspace.runId,
    state: "created",
    updated_at: new Date().toISOString(),
    active_plan_path: null,
    active_review_stage: null,
    used_agent_calls: 0,
    remaining_agent_calls: manifest.options.agentCallBudget,
    worker_statuses: {},
    final_artifact_paths: [],
    last_event_sequence: 0,
  };
  await writeJson(artifactPath(workspace, "run-state.json"), state);
  await appendEvent(workspace, "state_transition", "coordinator", { from: null, to: "created" });
  return workspace;
}

export async function getState(workspace: Workspace): Promise<RunState> {
  return runStateSchema.parse(await readJson(artifactPath(workspace, "run-state.json")));
}

export async function appendEvent(workspace: Workspace, type: string, actor: EventRecord["actor"], payload: Record<string, unknown>): Promise<EventRecord> {
  const state = await getState(workspace);
  const sequence = state.last_event_sequence + 1;
  const previousPath = sequence > 1 ? artifactPath(workspace, `events/${String(sequence - 1).padStart(6, "0")}-event.json`) : null;
  const previousEventSha = previousPath && await exists(previousPath) ? createHash("sha256").update(await readFile(previousPath)).digest("hex") : null;
  const event: EventRecord = { schema_version: "1.0", run_id: workspace.runId, sequence, type, timestamp: new Date().toISOString(), actor, payload, previous_event_sha256: previousEventSha };
  const eventPath = artifactPath(workspace, `events/${String(sequence).padStart(6, "0")}-event.json`);
  await writeJson(eventPath, event);
  const eventLogPath = artifactPath(workspace, "logs/events.ndjson");
  await appendFile(eventLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(eventLogPath, 0o600);
  await writeJson(artifactPath(workspace, "run-state.json"), runStateSchema.parse({ ...state, updated_at: event.timestamp, last_event_sequence: sequence }));
  return event;
}

export async function transitionState(workspace: Workspace, nextState: RunState["state"], patch: Partial<Omit<RunState, "schema_version" | "run_id" | "state" | "updated_at" | "last_event_sequence">> = {}): Promise<RunState> {
  const previous = await getState(workspace);
  const event = await appendEvent(workspace, "state_transition", "coordinator", { from: previous.state, to: nextState });
  const next = runStateSchema.parse({ ...previous, ...patch, state: nextState, updated_at: new Date().toISOString(), last_event_sequence: event.sequence });
  await writeJson(artifactPath(workspace, "run-state.json"), next);
  return next;
}

export async function assertWorkspace(path: string): Promise<Workspace> {
  const root = resolve(path);
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory()) throw new RegCompareError("invalid_run", `Run directory does not exist: ${root}`, 6);
  const manifest = await readJson<RunManifest>(join(root, "manifest.json")).catch(() => null);
  if (!manifest?.run_id) throw new RegCompareError("invalid_run", `Run manifest is missing or invalid: ${root}`, 6);
  return { root, runId: manifest.run_id };
}
