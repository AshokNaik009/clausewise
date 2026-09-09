import { z } from "zod";
import { decisionSchema, requestSchema } from "../runtime/approvals.js";
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
  z.object({ type: z.literal("reasoning"), text: z.string(), namespace: z.array(z.string()) }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()), namespace: z.array(z.string()) }),
  z.object({ type: z.literal("tool_result"), id: z.string(), name: z.string(), content: z.string(), status: z.enum(["success", "error"]).optional(), namespace: z.array(z.string()) }),
  z.object({ type: z.literal("approval_required"), requests: z.array(requestSchema) }),
  z.object({ type: z.literal("result"), result: resultSchema }),
  z.object({ type: z.literal("policy"), mode: modeSchema, message: z.string() }),
  z.object({ type: z.literal("notice"), message: z.string() }),
  z.object({ type: z.literal("terminal"), sequence: z.string().max(16_000) }),
]);
export type CodeEvent = z.infer<typeof eventSchema>;
export const runtimeSettingsSchema = z.object({
  projectContext: z.boolean().optional(),
  shellTimeoutSeconds: z.number().int().min(1).max(900).optional(),
  trustExtensions: z.boolean().optional(),
  configFile: z.string().min(1).optional(),
  recursionLimit: z.number().int().min(1).max(100_000).optional(),
  agent: z.string().min(1).optional(),
}).strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const statusSchema = z.object({
  session: sessionSchema,
  options: runtimeSettingsSchema.default({}),
  mode: modeSchema,
  state: z.enum(["idle", "running", "cancelling", "awaiting_approval", "incomplete", "error"]),
  runId: z.string().uuid().nullable(),
  result: resultSchema,
});
export type ServerStatus = z.infer<typeof statusSchema>;
const decision = decisionSchema;
export const commandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("initialize"), directory: z.string().min(1), sessionId: z.string().uuid(), options: runtimeSettingsSchema }).strict(),
  z.object({ method: z.literal("select"), sessionId: z.string().uuid().nullable() }).strict(),
  z.object({ method: z.literal("run"), runId: z.string().uuid(), prompt: z.string().max(1_000_000).nullable(), decisions: z.record(z.string(), z.array(decision)).optional() }).strict(),
  z.object({ method: z.literal("cancel"), runId: z.string().uuid() }).strict(),
  z.object({ method: z.literal("configure"), reload: z.boolean() }).strict(),
  z.object({ method: z.literal("settings"), scope: z.enum(["session", "user"]), patch: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ method: z.literal("rename"), title: z.string().min(1).max(200) }).strict(),
  z.object({ method: z.literal("goal-clear") }).strict(),
  z.object({ method: z.literal("integrations"), action: z.enum(["reload", "enable", "disable"]), server: z.string().optional() }).strict(),
  z.object({ method: z.literal("plugins"), action: z.enum(["list", "marketplace-add", "preview", "install", "enable", "disable", "uninstall"]), argument: z.string().max(4096), digest: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict(),
  z.object({ method: z.literal("model"), provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), model: z.string().min(1).max(200) }).strict(),
  z.object({ method: z.literal("auth"), key: z.string().min(1).max(16_384).optional() }).strict(),
  z.object({ method: z.literal("models") }).strict(),
  z.object({ method: z.literal("inventory") }).strict(),
  z.object({ method: z.literal("skills") }).strict(),
  z.object({ method: z.literal("skill"), name: z.string().min(1).max(200), argument: z.string().max(100_000) }).strict(),
  z.object({ method: z.literal("trace") }).strict(),
  z.object({ method: z.literal("preview"), requestId: z.string().min(1).max(200), action: z.number().int().min(0).max(1000) }).strict(),
  z.object({ method: z.literal("controls") }).strict(),
  z.object({ method: z.literal("compact"), runId: z.string().uuid() }).strict(),
  z.object({ method: z.literal("archives"), restore: z.string().uuid().optional() }).strict(),
  z.object({ method: z.literal("memory"), text: z.string().max(16_000) }).strict(),
  z.object({ method: z.literal("goal"), objective: z.string().min(1).max(8000), criteria: z.array(z.string().min(1).max(2000)).min(1).max(20), revision: z.number().int().nonnegative().optional() }).strict(),
  z.object({ method: z.literal("rubric"), criteria: z.array(z.string().min(1).max(2000)).min(1).max(20).nullable(), scope: z.enum(["session", "next"]) }).strict(),
  z.object({ method: z.literal("goal-options"), target: z.enum(["goal", "rubric"]), options: z.object({ model: z.string().regex(/^[a-z][a-z0-9_-]*:.+$/u).nullable().optional(), maxIterations: z.number().int().min(1).max(100).optional() }).strict() }).strict(),
  z.object({ method: z.literal("goal-work"), runId: z.string().uuid(), target: z.enum(["goal", "rubric"]), action: z.enum(["draft", "amend", "grade"]), text: z.string().max(12_000) }).strict(),
  z.object({ method: z.literal("goal-update"), update: goalUpdateSchema }).strict(),
  z.object({ method: z.literal("mode"), mode: modeSchema, acknowledgement: z.string().max(100).optional() }).strict(),
  ...(["status", "history", "sessions", "ping", "shutdown", "wait"] as const).map((method) => z.object({ method: z.literal(method) }).strict()),
]);
export type ServerCommand = z.infer<typeof commandSchema>;
export const clientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("request"), id: z.string().uuid(), command: commandSchema }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("ack"), eventId: z.number().int().positive() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const serverMessageSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("ready"), pid: z.number().int().positive(), oldestEventId: z.number().int().nonnegative(), latestEventId: z.number().int().nonnegative() }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("gap"), message: z.string(), eventId: z.number().int().nonnegative() }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("response"), id: z.string().uuid(), data: z.unknown(), error: z.string().optional() }).strict(),
  z.object({ version: z.literal(PROTOCOL_VERSION), kind: z.literal("event"), requestId: z.string().uuid(), sessionId: z.string().uuid(), runId: z.string().uuid(), eventId: z.number().int().positive(), event: eventSchema }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function checkMessageSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_IPC_BYTES) throw new Error("IPC message exceeds the 4 MiB limit");
}
