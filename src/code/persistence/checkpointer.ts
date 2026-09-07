import { MemorySaver, type Checkpoint, type CheckpointMetadata, type PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { atomicJson, isMissing, readJson } from "./storage.js";

const key = z.string().refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const bytes = z.string().base64().transform((value) => new Uint8Array(Buffer.from(value, "base64")));
const snapshotSchema = z.object({
  version: z.literal(1),
  storage: z.record(key, z.record(key, z.record(key, z.tuple([
    bytes, bytes, z.string().nullable().transform((value) => value ?? undefined),
  ])))),
  writes: z.record(key, z.record(key, z.tuple([z.string(), z.string(), bytes]))),
});

function mapValues<T, R>(object: Record<string, T>, map: (value: T) => R): Record<string, R> {
  return Object.fromEntries(Object.entries(object).map(([name, value]) => [name, map(value)]));
}

export class FileCheckpointer extends MemorySaver {
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private readonly threadId: string) {
    super();
  }

  static async load(path: string, threadId: string): Promise<FileCheckpointer> {
    const saver = new FileCheckpointer(path, threadId);
    let raw: unknown;
    try {
      raw = await readJson(path);
    } catch (error) {
      if (isMissing(error)) return saver;
      throw error;
    }
    const snapshot = snapshotSchema.parse(raw);
    if (Object.keys(snapshot.storage).some((id) => id !== threadId) || Object.keys(snapshot.writes).some((id) => {
      const parts: unknown = JSON.parse(id);
      return !Array.isArray(parts) || parts.length !== 3 || parts[0] !== threadId;
    })) throw new Error("Checkpoint does not belong to this session");
    saver.storage = snapshot.storage;
    saver.writes = snapshot.writes;
    return saver;
  }

  private assertThread(config: RunnableConfig): void {
    if (config.configurable?.thread_id !== this.threadId) throw new Error("Checkpointer is restricted to its session");
  }

  private persist(): Promise<void> {
    this.pending = this.pending.then(() => atomicJson(this.path, {
      version: 1,
      storage: mapValues(this.storage, (namespaces) => mapValues(namespaces, (checkpoints) => mapValues(checkpoints,
        ([checkpoint, metadata, parent]) => [Buffer.from(checkpoint).toString("base64"), Buffer.from(metadata).toString("base64"), parent ?? null]))),
      writes: mapValues(this.writes, (writes) => mapValues(writes,
        ([task, channel, value]) => [task, channel, Buffer.from(value).toString("base64")])),
    }));
    return this.pending;
  }

  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    this.assertThread(config);
    const result = await super.put(config, checkpoint, metadata);
    await this.persist();
    return result;
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    this.assertThread(config);
    await super.putWrites(config, writes, taskId);
    await this.persist();
  }

  override async deleteThread(): Promise<void> {
    throw new Error("Session deletion is not supported by this port yet");
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
