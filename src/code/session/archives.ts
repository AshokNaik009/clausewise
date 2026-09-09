import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { readJson } from "../persistence/storage.js";

export const archiveIdSchema = z.string().uuid();
export const archiveInfoSchema = z.object({ id: archiveIdSchema, createdAt: z.string().datetime(), messages: z.number().int().nonnegative(), summary: z.string() });
const contentSchema = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough())]);
const messageSchema = z.object({ type: z.enum(["human", "ai", "system", "tool"]), data: z.object({ content: contentSchema, name: z.string().optional(), id: z.string().optional(), tool_call_id: z.string().optional(), tool_calls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()), id: z.string().optional(), type: z.literal("tool_call").optional() })).optional() }) });
const archiveSchema = z.object({ version: z.literal(1), checkpointId: z.string(), messages: z.array(messageSchema).max(100_000), summary: z.string().max(64_000), createdAt: z.string().datetime() });

export function restoreMessages(input: unknown): BaseMessage[] {
  const stored = z.array(messageSchema).max(100_000).parse(input);
  const pending = new Set<string>();
  return stored.map(({ type, data }, index) => {
    if (type !== "tool" && pending.size) throw new Error("Archive contains unresolved tool calls; it cannot be restored as completed history");
    if (type === "ai") {
      for (const call of data.tool_calls ?? []) {
        if (!call.id || pending.has(call.id)) throw new Error("Archive tool call IDs are missing or duplicated");
        pending.add(call.id);
      }
    }
    if (type === "tool") {
      if (!data.tool_call_id || !pending.delete(data.tool_call_id)) throw new Error("Archive contains an unmatched tool result");
    }
    if (index === stored.length - 1 && pending.size) throw new Error("Archive ends with pending tool calls");
    const fields = { content: data.content, ...(data.name ? { name: data.name } : {}), ...(data.id ? { id: data.id } : {}) };
    if (type === "human") return new HumanMessage(fields);
    if (type === "system") return new SystemMessage(fields);
    if (type === "tool") return new ToolMessage({ ...fields, tool_call_id: data.tool_call_id! });
    return new AIMessage({ ...fields, ...(data.tool_calls ? { tool_calls: data.tool_calls.map((call) => ({ name: call.name, args: call.args, ...(call.id ? { id: call.id } : {}), type: "tool_call" as const })) } : {}) });
  });
}

export async function readArchive(directory: string, id: string) {
  archiveIdSchema.parse(id);
  const archive = archiveSchema.parse(await readJson(join(directory, `compaction-${id}.json`)));
  return { ...archive, restored: restoreMessages(archive.messages) };
}

export async function listArchives(directory: string) {
  const files = (await readdir(directory)).filter((name) => /^compaction-[a-f0-9-]+\.json$/u.test(name));
  const result = [];
  for (const file of files) {
    const id = file.slice(11, -5);
    const archive = await readArchive(directory, id);
    result.push({ id, createdAt: archive.createdAt, messages: archive.messages.length, summary: archive.summary });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
