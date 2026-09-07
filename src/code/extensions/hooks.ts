import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { HookDefinition } from "./config.js";
import { registerSecret } from "../config/credentials.js";

const outputSchema = z.object({ continue: z.boolean().optional(), stopReason: z.string().max(4000).optional(), decision: z.enum(["block", "approve"]).optional(), hookSpecificOutput: z.object({ permissionDecision: z.enum(["allow", "deny", "ask"]).optional(), permissionDecisionReason: z.string().max(4000).optional() }).passthrough().optional() }).passthrough();

export class HookRunner {
  private readonly children = new Set<ChildProcess>();
  private readonly lifetime = new AbortController();
  constructor(private readonly definitions: HookDefinition[], private readonly cwd: string) {}

  private kill(child: ChildProcess): void {
    if (!child.pid) return;
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }

  private async invoke(definition: HookDefinition, payload: string, parentSignal: AbortSignal | undefined): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(definition.timeoutSeconds * 1000)]);
    signal.throwIfAborted();
    for (const name of definition.envKeys) if (process.env[name]) registerSecret(process.env[name]!);
    const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT", ...definition.envKeys].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(definition.argv[0]!, definition.argv.slice(1), { cwd: this.cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      const chunks: Buffer[] = [];
      let size = 0;
      let oversized = false;
      const capture = (chunk: Buffer, save: boolean) => {
        size += chunk.length;
        if (size > 64_000) { oversized = true; this.kill(child); }
        else if (save) chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, false));
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
          if (oversized || code !== 0) throw new Error(oversized ? "Hook output exceeded its limit" : `Hook ${definition.event} blocked or failed (exit ${code})`);
          const output = Buffer.concat(chunks).toString("utf8").trim();
          if (output) {
            const result = outputSchema.parse(JSON.parse(output));
            if (result.continue === false || result.decision === "block" || ["deny", "ask"].includes(result.hookSpecificOutput?.permissionDecision ?? "")) throw new Error(result.stopReason ?? result.hookSpecificOutput?.permissionDecisionReason ?? "Action blocked by hook");
          }
          resolve();
        } catch (error) { reject(error); }
      });
      child.stdin.end(payload);
    });
  }

  async run(event: HookDefinition["event"], data: Record<string, unknown>, signal: AbortSignal | undefined): Promise<void> {
    const matches = this.definitions.filter((definition) => definition.event === event && (definition.matcher === "*" || definition.matcher === data.tool_name));
    if (!matches.length) return;
    const payload = JSON.stringify({ schema_version: 1, hook_event_name: event, cwd: this.cwd, ...data });
    if (payload.length > 1_000_000) throw new Error("Hook payload exceeds 1 MB");
    for (const definition of matches) await this.invoke(definition, payload, signal);
  }

  async close(): Promise<void> {
    const done = [...this.children].map((child) => new Promise<void>((resolve) => child.once("close", () => resolve())));
    this.lifetime.abort();
    await Promise.all(done);
  }
}
