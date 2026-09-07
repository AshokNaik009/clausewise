import { spawn, type ChildProcess } from "node:child_process";
import { runInNewContext } from "node:vm";
import type { HookDefinition } from "./config.js";
import { registerSecret } from "../config/credentials.js";
import { errorText } from "../shared/output.js";
import { hookOutputSchema, reduceHooks, type HandlerResult, type HookOutcome } from "./hook-output.js";
export type { HookOutcome } from "./hook-output.js";

const wireNames: Record<string, string> = { execute: "Bash", write_file: "Write", edit_file: "Edit", read_file: "Read", ls: "LS", glob: "Glob", grep: "Grep", task: "Task", web_search: "WebSearch", fetch_url: "WebFetch" };
const matcherFields: Partial<Record<HookDefinition["event"], string>> = { SessionStart: "cause", SessionEnd: "cause", PermissionRequest: "tool_name", Notification: "notification_type", PreToolUse: "tool_name", PostToolUse: "tool_name", PostToolUseFailure: "tool_name", PreCompact: "trigger", SubagentStart: "agent_name", SubagentStop: "agent_name" };

function matches(pattern: string, value: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (/^[\p{Letter}\p{Number}_\s,|\-]+$/u.test(pattern)) return pattern.split(/[|,]/u).map((name) => name.trim()).includes(value);
  const flags = /^\(\?([ims]+)\)/u.exec(pattern);
  const source = pattern.replace(/^\(\?[ims]+\)/u, "").replace(/\(\?P</gu, "(?<").replace(/\\A/gu, "^").replace(/\\Z/gu, "$");
  return Boolean(runInNewContext("new RegExp(pattern, flags).test(value)", { pattern: source, flags: `${flags?.[1] ?? ""}u`, value: value.slice(0, 2000) }, { timeout: 25, contextCodeGeneration: { strings: false, wasm: false } }));
}

export class HookRunner {
  onNotice: ((message: string) => void | Promise<void>) | undefined;
  onTerminal: ((sequence: string) => void | Promise<void>) | undefined;
  prepare: (() => Promise<Record<string, unknown>>) | undefined;
  private readonly children = new Set<ChildProcess>();
  private readonly lifetime = new AbortController();
  constructor(private readonly definitions: HookDefinition[], private readonly cwd: string, private readonly diagnostics: string[] = []) {}

  private kill(child: ChildProcess): void {
    if (!child.pid) return;
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }

  private async invoke(definition: HookDefinition, payload: Record<string, unknown>, parentSignal?: AbortSignal): Promise<HandlerResult> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(Math.ceil(definition.timeoutSeconds * 1000))]);
    signal.throwIfAborted();
    for (const name of definition.envKeys) if (process.env[name]) registerSecret(process.env[name]!);
    for (const [name, value] of Object.entries(definition.environment)) if (/(?:TOKEN|KEY|PASSWORD|SECRET)/iu.test(name)) registerSecret(value);
    const env = { ...Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT", ...definition.envKeys].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])), ...definition.environment };
    if (definition.statusMessage) await this.onNotice?.(definition.statusMessage);
    const input = definition.legacyEvent ? { event: definition.legacyEvent, ...(["session.start", "task.complete", "session.end"].includes(definition.legacyEvent) ? { thread_id: payload.session_id } : {}) } : payload;
    return new Promise((resolve, reject) => {
      const child = spawn(definition.argv[0]!, definition.argv.slice(1), { cwd: this.cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let oversized = false;
      const capture = (chunk: Buffer, target: Buffer[]) => { size += chunk.length; if (size > 128_000) { oversized = true; this.kill(child); } else target.push(chunk); };
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, chunks));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, errors));
      child.stdin.on("error", () => undefined);
      const abort = () => this.kill(child);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const cleanup = () => { signal.removeEventListener("abort", abort); this.children.delete(child); };
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("close", (code) => {
        cleanup();
        try {
          signal.throwIfAborted();
          if (oversized) throw new Error("Hook output exceeded 128 KB");
          if (definition.legacyEvent) { resolve({ diagnostics: [] }); return; }
          if (code === 2) { resolve({ diagnostics: [], output: { decision: "block", reason: Buffer.concat(errors).toString("utf8").trim().slice(0, 4000) || "Blocked by hook" } }); return; }
          if (code !== 0) throw new Error(`Hook exited ${code}`);
          const output = Buffer.concat(chunks).toString("utf8").trim();
          if (!output) { resolve({ diagnostics: [] }); return; }
          let value: unknown;
          try { value = JSON.parse(output); }
          catch { resolve({ diagnostics: [], plain: output.slice(0, 64_000) }); return; }
          resolve({ diagnostics: [], output: hookOutputSchema.parse(value) });
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }

  async run(event: HookDefinition["event"], data: Record<string, unknown>, signal: AbortSignal | undefined): Promise<HookOutcome> {
    signal?.throwIfAborted();
    const field = matcherFields[event];
    const original = String(field ? data[field] ?? "" : "");
    const value = field === "tool_name" ? wireNames[original] ?? original : original;
    const diagnostics: string[] = [];
    const definitions = this.definitions.filter((definition) => {
      if (definition.event !== event) return false;
      try { return matches(definition.matcher, value) || (definition.nativeMatcher === true && matches(definition.matcher, original)); }
      catch { diagnostics.push(`${event}: invalid or excessively expensive matcher excluded`); return false; }
    });
    const context = definitions.length ? await this.prepare?.() ?? {} : {};
    const payload = { ...context, ...data, ...(field === "tool_name" ? { tool_name: value, native_tool_name: original } : {}), ...(event === "SessionStart" ? { source: data.cause } : event === "SessionEnd" ? { reason: data.cause } : {}), ...(data.tool_call_id ? { tool_use_id: data.tool_call_id } : {}), ...(data.agent_name ? { agent_type: data.agent_name } : {}), schema_version: 1, hook_event_name: event, cwd: this.cwd };
    if (Buffer.byteLength(JSON.stringify(payload)) > 1_000_000) throw new Error("Hook payload exceeds 1 MB");
    const results = await Promise.all(definitions.map(async (definition): Promise<HandlerResult> => {
      try { return await this.invoke(definition, payload, signal); }
      catch (error) { return { diagnostics: [`${event}: ${errorText(error)}`] }; }
    }));
    signal?.throwIfAborted();
    const outcome = reduceHooks(event, [...results, { diagnostics }], typeof data.continuation_count === "number" ? data.continuation_count : 0);
    this.diagnostics.push(...outcome.diagnostics, ...outcome.notices);
    if (this.diagnostics.length > 200) this.diagnostics.splice(0, this.diagnostics.length - 200);
    for (const message of [...outcome.notices, ...outcome.diagnostics]) await this.onNotice?.(message);
    for (const sequence of outcome.terminalSequences) await this.onTerminal?.(sequence);
    return outcome;
  }

  async guard(event: HookDefinition["event"], data: Record<string, unknown>, signal?: AbortSignal): Promise<HookOutcome> {
    const result = await this.run(event, data, signal);
    if (result.blocked || result.permission === "ask") throw new Error(result.reason ?? "Hook requires human review; no action was executed");
    return result;
  }

  async close(): Promise<void> {
    const done = [...this.children].map((child) => new Promise<void>((resolve) => child.once("close", () => resolve())));
    this.lifetime.abort();
    await Promise.all(done);
  }
}
