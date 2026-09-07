import { z } from "zod";
import { requestSchema } from "../runtime/approvals.js";
import { sessionSchema } from "../persistence/sessions.js";
import { costSummarySchema, goalUpdateSchema, modeSchema } from "./session-controls.js";

export const PROTOCOL_VERSION = 1;
export const MAX_IPC_BYTES = 4 * 1024 * 1024;
export const usageSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), total: z.number().nonnegative() });
export const resultSchema = z.object({
  sessionId: z.string().uuid(),
  status: z.enum(["completed", "interrupted", "incomplete"]),
  text: z.string(),
  approvals: z.array(requestSchema),
  usage: usageSchema,
  costs: costSummarySchema.optional(),
});
export type TokenUsage = z.infer<typeof usageSchema>;
export type TurnResult = z.infer<typeof resultSchema>;
export const conversationSchema = z.object({ role: z.string(), text: z.string() });
export type ConversationMessage = z.infer<typeof conversationSchema>;
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), namespace: z.array(z.string()) }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()), namespace: z.array(z.string()) }),
  z.object({ type: z.literal("tool_result"), id: z.string(), name: z.string(), content: z.string(), namespace: z.array(z.string()) }),
  z.object({ type: z.literal("approval_required"), requests: z.array(requestSchema) }),
  z.object({ type: z.literal("result"), result: resultSchema }),
  z.object({ type: z.literal("policy"), mode: modeSchema, message: z.string() }),
]);
export type CodeEvent = z.infer<typeof eventSchema>;
export const runtimeSettingsSchema = z.object({
  projectContext: z.boolean().optional(),
  shellTimeoutSeconds: z.number().int().min(1).max(900).optional(),
  trustExtensions: z.boolean().optional(),
}).strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const statusSchema = z.object({
  session: sessionSchema,
  mode: modeSchema,
  state: z.enum(["idle", "running", "cancelling", "awaiting_approval", "incomplete", "error"]),
  runId: z.string().uuid().nullable(),
  result: resultSchema,
});
export type ServerStatus = z.infer<typeof statusSchema>;
const decision = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }).strict(),
  z.object({ type: z.literal("reject"), message: z.string().max(10_000).optional() }).strict(),
]);
export const commandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("initialize"), directory: z.string().min(1), sessionId: z.string().uuid(), options: runtimeSettingsSchema }).strict(),
  z.object({ method: z.literal("select"), sessionId: z.string().uuid().nullable() }).strict(),
  z.object({ method: z.literal("run"), runId: z.string().uuid(), prompt: z.string().max(1_000_000).nullable(), decisions: z.record(z.string(), z.array(decision)).optional() }).strict(),
  z.object({ method: z.literal("cancel"), runId: z.string().uuid() }).strict(),
  z.object({ method: z.literal("configure"), reload: z.boolean() }).strict(),
  z.object({ method: z.literal("model"), provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), model: z.string().min(1).max(200) }).strict(),
  z.object({ method: z.literal("auth"), key: z.string().min(1).max(16_384).optional() }).strict(),
  z.object({ method: z.literal("models") }).strict(),
  z.object({ method: z.literal("inventory") }).strict(),
  z.object({ method: z.literal("controls") }).strict(),
  z.object({ method: z.literal("compact"), runId: z.string().uuid() }).strict(),
  z.object({ method: z.literal("memory"), text: z.string().max(16_000) }).strict(),
  z.object({ method: z.literal("goal"), objective: z.string().min(1).max(8000), criteria: z.array(z.string().min(1).max(2000)).min(1).max(20) }).strict(),
  z.object({ method: z.literal("goal-update"), update: goalUpdateSchema }).strict(),
  z.object({ method: z.literal("mode"), mode: modeSchema, acknowledgement: z.string().max(100).optional() }).strict(),
  ...(["status", "history", "sessions", "ping", "shutdown"] as const).map((method) => z.object({ method: z.literal(method) }).strict()),
]);
export type ServerCommand = z.infer<typeof commandSchema>;
export const clientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("request"), id: z.string().uuid(), command: commandSchema }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("ack"), eventId: z.number().int().positive() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const serverMessageSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("ready"), pid: z.number().int().positive() }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("response"), id: z.string().uuid(), data: z.unknown(), error: z.string().optional() }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("event"), requestId: z.string().uuid(), sessionId: z.string().uuid(), runId: z.string().uuid(), eventId: z.number().int().positive(), event: eventSchema }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function checkMessageSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_IPC_BYTES) throw new Error("IPC message exceeds the 4 MiB limit");
}
