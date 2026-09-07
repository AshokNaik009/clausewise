import { z } from "zod";

export const goalProposalSchema = z.object({ objective: z.string().trim().min(1).max(8000), criteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(20) }).refine((goal) => goal.objective.length + goal.criteria.join("\n").length <= 12_000, "Goal and acceptance criteria exceed the combined limit");
export const assessmentSchema = z.object({ criteria: z.array(z.object({ criterion: z.string().max(2000), verdict: z.enum(["met", "unmet", "unknown"]), evidence: z.string().max(4000) }).strict()).min(1).max(20), summary: z.string().max(4000) }).strict();
export const goalSchema = z.object({
  id: z.string().uuid(), objective: z.string().min(1).max(8000), criteria: z.array(z.string().min(1).max(2000)).min(1).max(20),
  status: z.enum(["active", "paused", "blocked", "complete"]), note: z.string().max(4000), updatedAt: z.string().datetime(),
  model: z.string().max(300).nullable().default(null), maxIterations: z.number().int().min(1).max(100).default(3), iterations: z.number().int().nonnegative().default(0), assessment: assessmentSchema.nullable().default(null), revision: z.number().int().nonnegative().default(0),
}).refine((goal) => goal.objective.length + goal.criteria.join("\n").length <= 12_000, "Goal and acceptance criteria exceed the combined limit");
export const rubricSchema = z.object({ criteria: z.array(z.string().min(1).max(2000)).min(1).max(20), scope: z.enum(["session", "next"]), model: z.string().max(300).nullable().default(null), maxIterations: z.number().int().min(1).max(100).default(3), iterations: z.number().int().nonnegative().default(0), assessment: assessmentSchema.nullable().default(null) }).refine((rubric) => rubric.criteria.join("\n").length <= 12_000);
export const controlsSchema = z.object({ version: z.literal(1), memory: z.string().max(16_000), goal: goalSchema.nullable(), rubric: rubricSchema.nullable().default(null), previousRubric: rubricSchema.nullable().default(null), turnActive: z.boolean().default(false), costWarningShown: z.boolean().default(false) });
export type ControlsState = z.infer<typeof controlsSchema>;
export const goalUpdateSchema = z.object({ status: z.enum(["active", "paused", "blocked", "complete"]), note: z.string().min(1).max(4000) }).strict();
export const tokenDetailsSchema = z.object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative(), total_tokens: z.number().nonnegative(), input_token_details: z.record(z.string(), z.number().nonnegative()).optional(), output_token_details: z.record(z.string(), z.number().nonnegative()).optional() });
export const priceSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional() }).strict();
export type ModelPrice = z.infer<typeof priceSchema>;
export const costSummarySchema = z.object({ requests: z.number(), input: z.number(), output: z.number(), knownCostUsd: z.number(), unpricedRequests: z.number(), cacheRead: z.number(), reasoning: z.number() });
export const modeSchema = z.enum(["manual", "auto", "yolo"]);
export type ApprovalMode = z.infer<typeof modeSchema>;
export const YOLO_ACKNOWLEDGEMENT = "I accept unrestricted host execution";
