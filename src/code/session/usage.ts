import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import { priceSchema } from "../protocol/session-controls.js";
import { isMissing } from "../persistence/storage.js";

import { tokenDetailsSchema as tokens, type ModelPrice } from "../protocol/session-controls.js";
export const usageEntrySchema = z.object({ version: z.literal(1), requestId: z.string(), parentId: z.string().nullable(), sessionId: z.string(), model: z.string(), provider: z.string(), endpoint: z.string(), timestamp: z.string().datetime(), usage: tokens.nullable(), costUsd: z.number().nonnegative().nullable() });
export type UsageEntry = z.infer<typeof usageEntrySchema>;
export { costSummarySchema } from "../protocol/session-controls.js";

function estimate(usage: z.infer<typeof tokens> | null, price: ModelPrice | undefined): number | null {
  if (!usage || !price) return null;
  const read = usage.input_token_details?.cache_read ?? 0;
  const write = usage.input_token_details?.cache_creation ?? 0;
  if ((read > 0 && price.cacheRead === undefined) || (write > 0 && price.cacheWrite === undefined) || read + write > usage.input_tokens) return null;
  return ((usage.input_tokens - read - write) * price.input + usage.output_tokens * price.output + read * (price.cacheRead ?? 0) + write * (price.cacheWrite ?? 0)) / 1_000_000;
}

export class UsageLedger extends BaseCallbackHandler {
  name = "dcode_usage";
  private entries: UsageEntry[] = [];
  private readonly seen = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private readonly requests = new Map<string, { model: string; provider: string; endpoint: string; price: ModelPrice | null }>();

  override handleChatModelStart(_model: Serialized, _messages: BaseMessage[][], runId: string, _parentId?: string, _extra?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>): void {
    const identity = z.object({ model: z.string(), provider: z.string(), endpoint: z.string(), price: priceSchema.nullable() }).safeParse(metadata?.dcode_usage);
    if (identity.success) this.requests.set(runId, identity.data);
  }

  override handleLLMError(_error: Error, runId: string): void { this.requests.delete(runId); }
  private constructor(private readonly directory: string, private readonly identity: { sessionId: string; model: string; provider: string; endpoint: string }, private readonly prices: Record<string, ModelPrice>) { super({ _awaitHandler: true, raiseError: true }); }

  static async load(directory: string, identity: { sessionId: string; model: string; provider: string; endpoint: string }, prices: Record<string, ModelPrice> = {}): Promise<UsageLedger> {
    const ledger = new UsageLedger(directory, identity, prices);
    try {
      const file = await open(join(directory, "usage.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await file.stat()).size > 64 * 1024 * 1024) throw new Error("Usage ledger exceeds the 64 MiB limit");
        const content = await file.readFile("utf8");
        if (content && !content.endsWith("\n")) throw new Error("Usage ledger has a partial record; preserve it for recovery");
        for (const line of content.split("\n").filter(Boolean)) {
          const entry = usageEntrySchema.parse(JSON.parse(line));
          if (entry.sessionId !== identity.sessionId) throw new Error("Usage ledger session mismatch");
          if (!ledger.seen.has(entry.requestId)) { ledger.entries.push(entry); ledger.seen.add(entry.requestId); }
        }
      } finally { await file.close(); }
    } catch (error) { if (!isMissing(error)) throw error; }
    return ledger;
  }

  override async handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): Promise<void> {
    const generation = output.generations[0]?.[0];
    const message = generation && "message" in generation ? generation.message : undefined;
    const usage = message && typeof message === "object" && "usage_metadata" in message ? tokens.safeParse(message.usage_metadata) : undefined;
    const parsed = usage?.success ? usage.data : null;
    const request = this.requests.get(runId);
    this.requests.delete(runId);
    const { price, ...identity } = request ?? { ...this.identity, price: this.prices[this.identity.model] ?? null };
    const entry: UsageEntry = { version: 1, ...identity, sessionId: this.identity.sessionId, requestId: runId, parentId: parentRunId ?? null, timestamp: new Date().toISOString(), usage: parsed, costUsd: estimate(parsed, price ?? undefined) };
    this.pending = this.pending.then(async () => {
      if (this.seen.has(runId)) return;
      const file = await open(join(this.directory, "usage.jsonl"), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        if ((await file.stat()).size > 64 * 1024 * 1024 - 32_768) throw new Error("Usage ledger reached its size limit");
        await file.writeFile(`${JSON.stringify(entry)}\n`);
        await file.sync();
        this.entries.push(entry);
        this.seen.add(runId);
      } finally { await file.close(); }
    });
    await this.pending;
  }

  summary() {
    return this.entries.reduce((total, entry) => ({
      requests: total.requests + 1,
      input: total.input + (entry.usage?.input_tokens ?? 0), output: total.output + (entry.usage?.output_tokens ?? 0),
      knownCostUsd: total.knownCostUsd + (entry.costUsd ?? 0), unpricedRequests: total.unpricedRequests + (entry.costUsd === null ? 1 : 0),
      cacheRead: total.cacheRead + (entry.usage?.input_token_details?.cache_read ?? 0), reasoning: total.reasoning + (entry.usage?.output_token_details?.reasoning ?? 0),
    }), { requests: 0, input: 0, output: 0, knownCostUsd: 0, unpricedRequests: 0, cacheRead: 0, reasoning: 0 });
  }

  async flush(): Promise<void> { await this.pending; }
}
