import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseApprovalDecisions, type ApprovalDecisions } from "../runtime/approvals.js";
import { Configuration, endpointSchema } from "../config/configuration.js";
import { DEFAULT_STATE_DIRECTORY, SessionStore, type SessionInfo } from "../persistence/sessions.js";

export interface LaunchOptions {
  model?: string;
  provider?: string;
  baseUrl?: string;
  execute?: string;
  resume?: string | true;
  attach?: string;
  config?: string;
  agent?: string;
  recursionLimit?: number;
  continue?: boolean;
  decisions?: string;
  cwd?: string;
  stateDir?: string;
  json?: boolean;
  streamJson?: boolean;
  projectContext?: boolean;
  trustExtensions?: boolean;
  shellTimeout?: number;
}

async function resolveSession(store: SessionStore, options: LaunchOptions): Promise<SessionInfo> {
  if (options.resume) {
    const query = options.resume;
    const sessions = await store.list();
    const cwd = await realpath(options.cwd ?? process.cwd());
    const matches = query === true ? sessions.filter((session) => session.cwd === cwd).slice(0, 1) : sessions.filter((session) => session.id.startsWith(query));
    if (matches.length !== 1) throw new Error(matches.length ? "Resume ID prefix is ambiguous" : "No matching session to resume");
    const info = matches[0]!;
    if (options.baseUrl && options.baseUrl !== info.baseUrl) throw new Error("Resume cannot change the stored endpoint; use an explicitly configured provider with --provider instead");
    if (options.cwd && await realpath(options.cwd) !== info.cwd) throw new Error("The requested directory differs from the resumed session directory");
    return info;
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const configuration = new Configuration(cwd, { ...(options.model ? { model: options.model } : {}), ...(options.provider ? { provider: options.provider } : {}) }, options.config ? { user: resolve(options.config) } : undefined);
  const effective = await configuration.reload();
  const model = effective.settings.model;
  if (!model) throw new Error("Choose a model with --model, DCODE_MODEL, or user configuration");
  const custom = options.baseUrl ?? process.env.DCODE_BASE_URL;
  if (custom && effective.provenance.provider === "managed") throw new Error("Managed provider policy forbids an endpoint override");
  const provider = custom ? "custom" : effective.settings.provider ?? "openai";
  const baseUrl = custom ? endpointSchema.parse(custom) : configuration.provider(provider).endpoint;
  return store.create({ cwd, model, provider, baseUrl });
}

async function readPrompt(prompt: string): Promise<string> {
  if (prompt !== "-") return prompt;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_000_000) throw new Error("Piped prompt exceeds the 1 MB limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function launch(options: LaunchOptions): Promise<number> {
  const headless = options.execute !== undefined || options.continue || options.decisions !== undefined;
  if (options.json && options.streamJson) throw new Error("Choose --json or --stream-json, not both");
  if (!headless && (options.json || options.streamJson)) throw new Error("Machine-readable output requires -x, --continue, or --decisions");
  if ((options.continue || options.decisions !== undefined) && !options.resume) throw new Error("--continue and --decisions require --resume");
  if (options.execute !== undefined && (options.continue || options.decisions !== undefined)) throw new Error("Do not combine a new prompt with continuation or approval decisions");
  if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Interactive mode requires a terminal. Use -x <prompt> or -x - for piped input.");
  const prompt = options.execute === undefined ? null : await readPrompt(options.execute);
  if (prompt !== null && !prompt.trim()) throw new Error("Prompt must not be empty");
  let decisions: ApprovalDecisions | undefined;
  if (options.decisions !== undefined) {
    try { decisions = parseApprovalDecisions(JSON.parse(options.decisions)); }
    catch { throw new Error("--decisions must map pending interrupt IDs to arrays of approve/reject decisions"); }
  }
  const store = new SessionStore(options.stateDir ?? DEFAULT_STATE_DIRECTORY);
  if (options.attach) {
    if (headless || options.resume || options.model || options.provider || options.baseUrl || options.cwd || options.config || options.agent || options.recursionLimit !== undefined || options.trustExtensions || options.projectContext === false || options.shellTimeout !== undefined) throw new Error("--attach uses the existing server configuration and cannot be combined with launch overrides");
    const { AgentClient } = await import("../client/agent-client.js");
    const client = await AgentClient.attach(store.directory, options.attach);
    try { const { runTerminal } = await import("../tui/app.js"); await runTerminal(client, store.directory); return 0; }
    finally { await client.close(); }
  }
  if (!headless) {
    const configuration = new Configuration(resolve(options.cwd ?? process.cwd()), {}, options.config ? { user: resolve(options.config) } : undefined);
    const { ApplicationUpdates } = await import("./updates.js");
    const updated = await new ApplicationUpdates((await configuration.reload()).settings).automatic((message) => { process.stderr.write(`${message}\n`); });
    if (updated) { process.stderr.write(`Updated to ${updated.version}. Restart the application; no prompt was submitted or session started.\n`); return 0; }
  }
  const info = await resolveSession(store, options);
  process.stderr.write(`Local execution is NOT sandboxed. Working directory: ${JSON.stringify(info.cwd)}\nSession: ${info.id}\n`);
  if (options.projectContext !== false) process.stderr.write("Project AGENTS.md and skill metadata may be loaded before tool approvals. Use --no-project-context to disable.\n");
  if (options.trustExtensions) process.stderr.write("Configured extensions are trusted for this run; MCP servers and hook commands may execute on the host.\n");
  const runtimeOptions = { trustExtensions: options.trustExtensions === true, ...(options.projectContext === false ? { projectContext: false } : {}), ...(options.shellTimeout !== undefined ? { shellTimeoutSeconds: options.shellTimeout } : {}), ...(options.config ? { configFile: resolve(options.config) } : {}), ...(options.agent ? { agent: options.agent } : {}), ...(options.recursionLimit !== undefined ? { recursionLimit: options.recursionLimit } : {}) };
  const { AgentClient } = await import("../client/agent-client.js");
  const client = await AgentClient.start(store.directory, info.id, runtimeOptions);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Run cancelled; the session can be resumed"));
  try {
    if (options.resume && (options.model || options.provider)) await client.switchModel(options.provider ?? info.provider ?? "openai", options.model ?? info.model);
    if (!headless) {
      const { runTerminal } = await import("../tui/app.js");
      await runTerminal(client, store.directory);
      return 0;
    }
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const { runHeadless } = await import("../client/headless.js");
    const format = options.streamJson ? "jsonl" : options.json ? "json" : "text";
    const result = await runHeadless(client, prompt, format, { signal: controller.signal, ...(decisions !== undefined ? { decisions } : {}) });
    return result.status === "interrupted" ? 3 : result.status === "incomplete" ? 4 : 0;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await client.close();
  }
}
