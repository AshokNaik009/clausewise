import { z } from "zod";
import type { HookDefinition } from "./config.js";

export function validTerminalSequence(value: string): boolean {
  return value.length <= 16_000 && /^(?:\u001b\](?:0|1|2|9|99|777);[^\u0000-\u001f\u007f-\u009f]*(?:\u0007|\u001b\\)|\u0007)+$/u.test(value);
}

const specificSchema = z.object({
  hookEventName: z.string().optional(), additionalContext: z.string().max(64_000).optional(),
  permissionDecision: z.enum(["allow", "deny", "ask", "defer"]).optional(), permissionDecisionReason: z.string().max(4000).optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  decision: z.object({ behavior: z.enum(["allow", "deny"]), message: z.string().optional(), interrupt: z.boolean().optional(), updatedInput: z.record(z.string(), z.unknown()).optional(), updatedPermissions: z.array(z.unknown()).optional() }).passthrough().optional(),
  suppressOriginalPrompt: z.boolean().optional(), sessionTitle: z.string().optional(),
  initialUserMessage: z.string().optional(), watchPaths: z.array(z.string()).optional(), reloadSkills: z.boolean().optional(),
  updatedToolOutput: z.unknown().optional(), updatedMCPToolOutput: z.unknown().optional(),
}).passthrough();
export const hookOutputSchema = z.object({ continue: z.boolean().optional(), stopReason: z.string().max(4000).optional(), decision: z.enum(["block", "approve"]).optional(), reason: z.string().max(4000).optional(), systemMessage: z.string().max(64_000).optional(), suppressOutput: z.boolean().optional(), terminalSequence: z.string().max(16_000).optional(), hookSpecificOutput: specificSchema.optional() }).passthrough();
export interface HandlerResult { output?: z.infer<typeof hookOutputSchema>; plain?: string; diagnostics: string[] }
export interface HookOutcome {
  context: string[]; feedback: string[]; notices: string[]; diagnostics: string[]; terminalSequences: string[];
  blocked: boolean; continueProcessing: boolean; continueLoop: boolean; suppressPrompt: boolean;
  reason?: string; permission?: "allow" | "deny" | "ask"; interrupt?: boolean;
}
const ranks = { allow: 1, ask: 2, deny: 3 };

export function reduceHooks(event: HookDefinition["event"], results: HandlerResult[], continuation = 0): HookOutcome {
  const state: HookOutcome = { context: [], feedback: [], notices: [], diagnostics: [], terminalSequences: [], blocked: false, continueProcessing: true, continueLoop: false, suppressPrompt: false };
  const unsupported = (name: string) => state.diagnostics.push(`${event}: ${name} is recognized but not applied by the upstream hook contract`);
  const permission = (behavior: "allow" | "deny" | "ask", reason?: string, interrupt?: boolean) => {
    if (!state.permission || ranks[behavior] > ranks[state.permission]) {
      state.permission = behavior;
      if (reason) state.reason = reason;
      if (interrupt !== undefined) state.interrupt = interrupt;
    }
  };
  const continueLoop = (message: string) => {
    if (continuation >= 8) { state.diagnostics.push("Stop continuation cap reached (8)"); return; }
    state.continueLoop = true; state.feedback.push(message);
  };
  for (const result of results) {
    state.diagnostics.push(...result.diagnostics);
    if (result.plain) {
      if (["SessionStart", "UserPromptSubmit"].includes(event)) state.context.push(result.plain);
      else state.diagnostics.push(`${event}: non-JSON output ignored`);
    }
    const output = result.output;
    if (!output) continue;
    if (output.continue === false) { state.continueProcessing = false; if (output.stopReason) state.reason ??= output.stopReason; }
    else if (output.stopReason) state.diagnostics.push(`${event}: stopReason ignored while continue is true`);
    if (output.systemMessage && !output.suppressOutput) state.notices.push(output.systemMessage);
    if (output.terminalSequence) {
      if (validTerminalSequence(output.terminalSequence)) state.terminalSequences.push(output.terminalSequence);
      else state.diagnostics.push(`${event}: unsafe terminalSequence rejected`);
    }
    for (const key of Object.keys(output)) if (!Object.hasOwn(hookOutputSchema.shape, key)) unsupported(key);
    if (output.decision === "block") {
      const reason = output.reason || "Blocked by hook";
      if (["PreToolUse", "PermissionRequest"].includes(event)) permission("deny", reason);
      else if (["UserPromptSubmit", "PreCompact"].includes(event)) { state.continueProcessing = false; state.reason ??= reason; }
      else if (["PostToolUse", "PostToolUseFailure"].includes(event)) state.feedback.push(reason);
      else if (event === "Stop") continueLoop(reason);
      else if (event === "SubagentStop") { state.context.push(reason); unsupported("blocking SubagentStop"); }
      else unsupported("block/exit 2");
    }
    const specific = output.hookSpecificOutput;
    if (!specific) continue;
    if (specific.hookEventName && specific.hookEventName !== event) { state.diagnostics.push(`${event}: mismatched hookSpecificOutput ignored`); continue; }
    if (specific.additionalContext) {
      if (event === "Stop") continueLoop(specific.additionalContext);
      else state.context.push(specific.additionalContext);
    }
    if (event === "UserPromptSubmit") state.suppressPrompt ||= specific.suppressOriginalPrompt === true;
    if (event === "PreToolUse") {
      let decision = specific.permissionDecision;
      if (decision === "defer") { unsupported("permissionDecision=defer"); decision = undefined; }
      if (specific.updatedInput !== undefined) { unsupported("updatedInput"); if (decision === "allow" || decision === "ask") decision = undefined; }
      if (decision) permission(decision, specific.permissionDecisionReason);
    }
    if (event === "PermissionRequest" && specific.decision) {
      const decision = specific.decision;
      if (decision.updatedInput !== undefined) unsupported("updatedInput");
      if (decision.updatedPermissions?.length) unsupported("updatedPermissions");
      if (decision.behavior === "deny") permission("deny", decision.message, decision.interrupt);
      else if (decision.updatedInput === undefined) permission("allow");
    }
    for (const key of ["initialUserMessage", "sessionTitle", "watchPaths", "reloadSkills", "updatedToolOutput", "updatedMCPToolOutput"] as const) if (specific[key] !== undefined && specific[key] !== false && specific[key] !== null && JSON.stringify(specific[key]) !== "[]") unsupported(key);
  }
  state.blocked = !state.continueProcessing || state.permission === "deny";
  for (const key of ["context", "feedback", "notices"] as const) state[key] = state[key].join("\n").slice(0, 64_000).split("\n").filter(Boolean);
  return state;
}
