import { terminalText } from "../shared/output.js";
import type { CodeEvent, TurnResult } from "../protocol/index.js";
import type { CodeRuntime, TurnOptions } from "../runtime/agent.js";

export type OutputFormat = "text" | "json" | "jsonl";

export function printEnvelope(command: string, data: unknown): void {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, command, data })}\n`);
}

export async function runHeadless(runtime: Pick<CodeRuntime, "turn">, prompt: string | null, format: OutputFormat, options: TurnOptions = {}): Promise<TurnResult> {
  let streamed = false;
  const onEvent = (event: CodeEvent) => {
    if (format === "jsonl") printEnvelope("run", event);
    if (event.type === "notice" || event.type === "policy") process.stderr.write(`\n${terminalText(event.message)}\n`);
    if (format !== "text") return;
    if (event.type === "text" && event.namespace.length === 0) {
      streamed = true;
      process.stdout.write(terminalText(event.text));
    }
    if (event.type === "tool_call") process.stderr.write(`\nRequested tool: ${terminalText(event.name)}\n`);
  };
  const result = await runtime.turn(prompt, { ...options, onEvent });
  if (format === "json") printEnvelope("run", result);
  if (format === "text") {
    if (!streamed && result.text) process.stdout.write(terminalText(result.text));
    process.stdout.write("\n");
    process.stderr.write(`Session: ${result.sessionId}\n`);
    if (result.approvals.length) process.stderr.write(`Approval required; no pending action has been approved. Resume interactively with -r ${result.sessionId}, or pass --decisions with an ID-keyed JSON object.\n${JSON.stringify(result.approvals, null, 2)}\n`);
  }
  return result;
}
