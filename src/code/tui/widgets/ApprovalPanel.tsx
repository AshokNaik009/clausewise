import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { z } from "zod";
import type { ApprovalDecision, ApprovalRequest } from "../../runtime/approvals.js";
import { errorText, terminalText } from "../../shared/output.js";
import { Composer } from "./Composer.js";

export function ApprovalPanel({ request, actionIndex, decide, height, lineNumbers = false, loadPreview }: { request: ApprovalRequest; actionIndex: number; decide: (decision: ApprovalDecision | undefined) => void; height: number; lineNumbers?: boolean; loadPreview?: () => Promise<string> }) {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<"arguments" | "rejection">();
  const [error, setError] = useState("");
  const action = request.value.actionRequests[actionIndex]!;
  const allowed = request.value.reviewConfigs[actionIndex]!.allowedDecisions;
  const args = action.args;
  const preview = action.name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string"
    ? `Proposed replacement (not applied): ${String(args.file_path ?? args.path ?? "")}\n${args.old_string.split("\n").map((line) => `- ${line}`).join("\n")}\n${args.new_string.split("\n").map((line) => `+ ${line}`).join("\n")}\n\nFull arguments:\n${JSON.stringify(args, null, 2)}` : JSON.stringify(args, null, 2);
  const [filePreview, setFilePreview] = useState<string>();
  useEffect(() => {
    let active = true;
    if (loadPreview) void loadPreview().then((text) => { if (active) setFilePreview(text); }).catch((error: unknown) => { if (active) setFilePreview(`Current-file preview unavailable: ${errorText(error)}\n${preview}`); });
    return () => { active = false; };
  }, [request.id, actionIndex]);
  const lines = terminalText(filePreview ?? preview).split("\n");
  const count = Math.max(1, height - 7);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) { if (editing) { setEditing(undefined); setError(""); } else decide(undefined); return; }
    if (editing) return;
    if (input === "p") decide(undefined);
    else if (input === "y" && allowed.includes("approve")) decide({ type: "approve" });
    else if ((input === "n" || key.return) && allowed.includes("reject")) decide({ type: "reject", message: "The user rejected this action." });
    else if (input === "r" && allowed.includes("reject")) setEditing("rejection");
    else if (input === "e" && allowed.includes("edit")) setEditing("arguments");
    else if (key.downArrow || key.pageDown) setOffset(Math.min(Math.max(0, lines.length - count), offset + (key.pageDown ? count : 1)));
    else if (key.upArrow || key.pageUp) setOffset(Math.max(0, offset - (key.pageUp ? count : 1)));
  });
  return <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
    <Text bold color="yellow">Approval: {terminalText(action.name)} ({actionIndex + 1}/{request.value.actionRequests.length})</Text>
    <Text dimColor>Requested action only. Host execution is not sandboxed.</Text>
    {editing ? <>
      <Text>{editing === "arguments" ? "Edit JSON arguments. Enter approves the edited action. Esc cancels editing." : "Rejection reason. Enter rejects with this feedback. Esc cancels."}</Text>
      <Composer key={editing} disabled={false} submit={(value) => {
        try {
          decide(editing === "arguments" ? { type: "edit", editedAction: { name: action.name, args: z.record(z.string(), z.unknown()).parse(JSON.parse(value)) } } : { type: "reject", message: value.slice(0, 10_000) });
          return true;
        } catch (error) { setError(errorText(error)); return false; }
      }} draft={{ text: editing === "arguments" ? JSON.stringify(args) : "", revision: 0 }} onDraft={() => undefined} />
      {error && <Text color="red">{error}</Text>}
    </> : <>
      {lines.slice(offset, offset + count).map((line, index) => <Text key={offset + index} wrap="truncate" {...(line.startsWith("- ") ? { color: "red" } : line.startsWith("+ ") ? { color: "green" } : {})}>{lineNumbers ? `${offset + index + 1} ` : ""}{line}</Text>)}
      <Text dimColor>Lines {offset + 1}-{Math.min(lines.length, offset + count)}/{lines.length} | arrows / PgUp / PgDn scroll</Text>
      <Text>{allowed.includes("approve") ? "y approve | " : ""}{allowed.includes("edit") ? "e edit | " : ""}{allowed.includes("reject") ? "n reject | r reason | " : ""}Esc pause</Text>
    </>}
  </Box>;
}
