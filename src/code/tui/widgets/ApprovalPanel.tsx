import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalDecision, ApprovalRequest } from "../../runtime/approvals.js";
import { terminalText } from "../../shared/output.js";

export function ApprovalPanel({ request, actionIndex, decide, height }: { request: ApprovalRequest; actionIndex: number; decide: (decision: ApprovalDecision | undefined) => void; height: number }) {
  const [offset, setOffset] = useState(0);
  const action = request.value.actionRequests[actionIndex]!;
  const allowed = request.value.reviewConfigs[actionIndex]!.allowedDecisions;
  const args = action.args;
  const preview = action.name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string"
    ? `Proposed replacement (not applied): ${String(args.file_path ?? args.path ?? "")}\n${args.old_string.split("\n").map((line) => `- ${line}`).join("\n")}\n${args.new_string.split("\n").map((line) => `+ ${line}`).join("\n")}\n\nFull arguments:\n${JSON.stringify(args, null, 2)}` : JSON.stringify(args, null, 2);
  const lines = terminalText(preview).split("\n");
  const count = Math.max(3, height - 7);
  useInput((input, key) => {
    if (key.escape || input === "p" || (key.ctrl && input === "c")) decide(undefined);
    else if (input === "y" && allowed.includes("approve")) decide({ type: "approve" });
    else if ((input === "n" || key.return) && allowed.includes("reject")) decide({ type: "reject", message: "The user rejected this action." });
    else if (key.downArrow || key.pageDown) setOffset(Math.min(Math.max(0, lines.length - count), offset + (key.pageDown ? count : 1)));
    else if (key.upArrow || key.pageUp) setOffset(Math.max(0, offset - (key.pageUp ? count : 1)));
  });
  return <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
    <Text bold color="yellow">Approval required: {terminalText(action.name)} ({actionIndex + 1}/{request.value.actionRequests.length})</Text>
    <Text dimColor>Requested action only. Host execution is not sandboxed.</Text>
    {lines.slice(offset, offset + count).map((line, index) => <Text key={offset + index} wrap="truncate" {...(line.startsWith("- ") ? { color: "red" } : line.startsWith("+ ") ? { color: "green" } : {})}>{line}</Text>)}
    <Text dimColor>Lines {offset + 1}-{Math.min(lines.length, offset + count)}/{lines.length} | arrows / PgUp / PgDn scroll</Text>
    <Text>{allowed.includes("approve") ? "y approve | " : ""}{allowed.includes("reject") ? "n / Enter reject | " : ""}p / Esc pause</Text>
  </Box>;
}
