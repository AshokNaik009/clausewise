import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { FilesystemBackend, type ExecuteResponse } from "deepagents/node";

const ENVIRONMENT_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "COMSPEC", "PATHEXT"];

export class CodeBackend extends FilesystemBackend {
  readonly id = `dcode-${randomUUID()}`;
  signal: AbortSignal | undefined;
  private readonly processes = new Set<ChildProcess>();
  private closed = false;

  constructor(private readonly workingDirectory: string, private readonly timeoutSeconds = 120) {
    super({ rootDir: workingDirectory, virtualMode: true });
  }

  private terminate(child: ChildProcess): void {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }

  async execute(command: string): Promise<ExecuteResponse> {
    if (this.closed) throw new Error("Shell backend is closed");
    this.signal?.throwIfAborted();
    const signal = this.signal;
    const env = Object.fromEntries(ENVIRONMENT_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd: this.workingDirectory, shell: true, detached: process.platform !== "win32", env, stdio: ["ignore", "pipe", "pipe"] });
      this.processes.add(child);
      const chunks: Buffer[] = [];
      let length = 0;
      let truncated = false;
      let timedOut = false;
      const capture = (chunk: Buffer) => {
        const available = Math.max(0, 100_000 - length);
        if (chunk.length > available) truncated = true;
        if (available) chunks.push(chunk.subarray(0, available));
        length += Math.min(chunk.length, available);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const abort = () => this.terminate(child);
      const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutSeconds * 1000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.processes.delete(child);
      };
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("close", (exitCode) => {
        cleanup();
        if (signal?.aborted) { reject(signal.reason); return; }
        const output = Buffer.concat(chunks).toString("utf8");
        resolve({ output: timedOut ? `${output}\nCommand timed out after ${this.timeoutSeconds}s` : output, exitCode: timedOut ? 124 : exitCode ?? 1, truncated });
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const processes = [...this.processes];
    await Promise.all(processes.map((child) => new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      this.terminate(child);
    })));
  }
}
