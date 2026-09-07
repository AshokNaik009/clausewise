import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import type { FileCheckpointer } from "./checkpointer.js";
import { atomicJson, privateDirectory, readJson } from "./storage.js";

const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "Invalid session ID");
export const sessionSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  cwd: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  provider: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;
export interface SessionContext {
  info: SessionInfo;
  directory?: string;
  checkpointer: FileCheckpointer;
  config: RunnableConfig;
  saveInfo?: (info: SessionInfo) => Promise<void>;
}
export const DEFAULT_STATE_DIRECTORY = join(homedir(), ".local", "state", "dcode-ts", "sessions");

export class SessionStore {
  readonly directory: string;

  constructor(directory = DEFAULT_STATE_DIRECTORY) {
    this.directory = resolve(directory);
  }

  private async sessionPath(id: string): Promise<string> {
    idSchema.parse(id);
    const path = join(this.directory, id);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Session directory must not be a symlink");
    return path;
  }

  async create(options: { cwd: string; model: string; baseUrl?: string; provider?: string }): Promise<SessionInfo> {
    await privateDirectory(this.directory);
    const cwd = await realpath(options.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw new Error("Working directory must be a directory");
    const now = new Date().toISOString();
    const info = sessionSchema.parse({ ...options, cwd, version: 1, id: randomUUID(), createdAt: now, updatedAt: now });
    const path = join(this.directory, info.id);
    await mkdir(path, { mode: 0o700 });
    await atomicJson(join(path, "session.json"), info);
    return info;
  }

  async get(id: string): Promise<SessionInfo> {
    const path = await this.sessionPath(id);
    const info = sessionSchema.parse(await readJson(join(path, "session.json")));
    if (info.id !== id) throw new Error("Session metadata ID mismatch");
    return info;
  }

  async list(): Promise<SessionInfo[]> {
    await privateDirectory(this.directory);
    const entries = await readdir(this.directory);
    const sessions = await Promise.all(entries.filter((name) => idSchema.safeParse(name).success).map((name) => this.get(name)));
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async use<T>(id: string, operation: (context: SessionContext) => Promise<T>): Promise<T> {
    const path = await this.sessionPath(id);
    const lockPath = join(path, "session.lock");
    const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Session is in use. If its process crashed, verify it has stopped before removing ${lockPath}`);
      }
      throw error;
    });
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      const info = await this.get(id);
      const { FileCheckpointer } = await import("./checkpointer.js");
      const checkpointer = await FileCheckpointer.load(join(path, "checkpoint.json"), id);
      try {
        return await operation({ info, directory: path, checkpointer, config: { configurable: { thread_id: id } }, saveInfo: async (next) => {
          const validated = sessionSchema.parse(next);
          if (validated.id !== id || validated.cwd !== info.cwd) throw new Error("Session identity cannot change");
          await atomicJson(join(path, "session.json"), validated);
          Object.assign(info, validated);
        } });
      } finally {
        await checkpointer.flush();
        await atomicJson(join(path, "session.json"), { ...info, updatedAt: new Date().toISOString() });
      }
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
