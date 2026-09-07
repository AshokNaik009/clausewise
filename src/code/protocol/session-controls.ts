import { z } from "zod";

export const goalSchema = z.object({
  id: z.string().uuid(), objective: z.string().min(1).max(8000), criteria: z.array(z.string().min(1).max(2000)).min(1).max(20),
  status: z.enum(["active", "paused", "blocked", "complete"]), note: z.string().max(4000), updatedAt: z.string().datetime(),
}).refine((goal) => goal.objective.length + goal.criteria.join("\n").length <= 12_000, "Goal and acceptance criteria exceed the combined limit");
export const controlsSchema = z.object({ version: z.literal(1), memory: z.string().max(16_000), goal: goalSchema.nullable() });
export type ControlsState = z.infer<typeof controlsSchema>;
export const goalUpdateSchema = z.object({ status: z.enum(["active", "paused", "blocked", "complete"]), note: z.string().min(1).max(4000) }).strict();
export const tokenDetailsSchema = z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(), total_tokens: z.number().nonnegative(), input_token_details: z.record(z.string(), z.number().nonnegative()).optional(), output_token_details: z.record(z.string(), z.number().nonnegative()).optional() });
export const priceSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional() }).strict();
export type ModelPrice = z.infer<typeof priceSchema>;
export const costSummarySchema = z.object({ requests: z.number(), input: z.number(), output: z.number(), knownCostUsd: z.number(), unpricedRequests: z.number(), cacheRead: z.number(), reasoning: z.number() });
export const modeSchema = z.enum(["manual", "auto", "yolo"]);
export type ApprovalMode = z.infer<typeof modeSchema>;
export const YOLO_ACKNOWLEDGEMENT = "I accept unrestricted host execution";
