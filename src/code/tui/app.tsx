import { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { AgentClient } from "../client/agent-client.js";
import { COMMANDS, parseCommand } from "../cli/commands.js";
import type { ApprovalDecision, ApprovalDecisions, ApprovalRequest } from "../runtime/approvals.js";
import { errorText, terminalText } from "../shared/output.js";
import { PARITY_MILESTONES, PORT_VERSION } from "../shared/parity.js";
import type { CodeEvent, ServerStatus } from "../protocol/index.js";
import { ApprovalPanel } from "./widgets/ApprovalPanel.js";
import { Composer } from "./widgets/Composer.js";
import { Picker, type PickerItem } from "./widgets/Picker.js";
import { SecretField } from "./widgets/SecretField.js";
import { ModeConfirmation } from "./widgets/ModeConfirmation.js";
import { goalUpdateSchema } from "../protocol/session-controls.js";

interface Review { requests: ApprovalRequest[]; request: number; action: number; decisions: ApprovalDecisions }
interface Selection { title: string; items: PickerItem[]; choose: (value: string) => Promise<void> }

function TerminalApp({ client }: { client: AgentClient }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [status, setStatus] = useState<ServerStatus>();
  const [transcript, setTranscript] = useState("Welcome. /help lists commands. Local execution is NOT sandboxed.\n");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [scroll, setScroll] = useState(0);
  const [review, setReview] = useState<Review>();
  const [picker, setPicker] = useState<Selection>();
  const [auth, setAuth] = useState(false);
  const [confirmMode, setConfirmMode] = useState(false);
  const [clock, setClock] = useState(0);
  const append = (text: string) => setTranscript((current) => (current + terminalText(text)).slice(-300_000));
  const refresh = async () => setStatus(await client.status());
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    const timer = setInterval(() => setClock((value) => value + 1), 200);
    const terminate = () => { void client.cancel().finally(() => exit()); };
    process.once("SIGTERM", terminate);
    void refresh().catch((error: unknown) => append(`\n${errorText(error)}\n`));
    return () => { stdout.off("resize", resize); clearInterval(timer); process.off("SIGTERM", terminate); };
  }, []);

  const perform = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await operation(); } catch (error) { append(`\n${errorText(error)}\n`); }
    finally {
      try { await refresh(); } catch (error) { append(`\n${errorText(error)}\n`); }
      busyRef.current = false;
      setBusy(false);
    }
  };
  const onEvent = (event: CodeEvent) => {
    if (event.type === "policy") { append(`\n[${event.mode}] ${event.message}\n`); setStatus((current) => current ? { ...current, mode: event.mode } : current); }
    if (event.type === "text") append(event.namespace.length ? `\n[${event.namespace.join("/")}] ${event.text}` : event.text);
    if (event.type === "tool_call") append(`\n[requested ${event.name}] ${JSON.stringify(event.args).slice(0, 2000)}\n`);
    if (event.type === "tool_result") append(`\n[result ${event.name}] ${event.content.slice(0, 12_000)}\n`);
  };
  const drive = async (prompt: string | null, decisions?: ApprovalDecisions) => {
    setScroll(0);
    const result = await client.turn(prompt, { onEvent, ...(decisions ? { decisions } : {}) });
    if (result.approvals.length) setReview({ requests: result.approvals, request: 0, action: 0, decisions: {} });
    append(`\n[${result.status}]\n`);
  };
  const select = async (id: string | null) => {
    const next = await client.select(id);
    setTranscript(`Session ${next.session.id}\n`);
    for (const message of await client.history()) append(`\n${message.role}: ${message.text}\n`);
    setStatus(next);
    setScroll(0);
  };
  const submit = (text: string) => { void perform(async () => {
    const command = parseCommand(text.trim());
    if (!command) { append(`\nYou: ${text}\n\n`); await drive(text); return; }
    switch (command.name) {
      case "quit": exit(); break;
      case "clear": await select(null); break;
      case "resume": await select(command.argument); break;
      case "continue": await drive(null); break;
      case "help": append(`\n${COMMANDS.map((entry) => `/${entry.name.padEnd(12)} ${entry.description}`).join("\n")}\n`); break;
      case "threads": setPicker({ title: "Resume a session", items: (await client.sessions()).map((session) => ({ value: session.id, label: `${session.id}  ${session.model}  ${session.cwd}` })), choose: select }); break;
      case "history": for (const message of await client.history()) append(`\n${message.role}: ${message.text}\n`); break;
      case "tokens": append(`\nRetained root usage: ${JSON.stringify((await client.result()).usage)}\n`); break;
      case "model": {
        const choose = async (value: string) => {
          const separator = value.indexOf(":");
          const provider = separator > 0 ? value.slice(0, separator) : client.session.provider ?? "openai";
          const model = separator > 0 ? value.slice(separator + 1) : value;
          await client.switchModel(provider, model);
          append(`\nModel switched to ${provider}:${model}; conversation preserved.\n`);
        };
        if (command.argument) await choose(command.argument);
        else setPicker({ title: "Select model (or /model provider:model)", items: (await client.models()).map(({ provider, model }) => ({ value: `${provider}:${model}`, label: `${provider}:${model}` })), choose });
        break;
      }
      case "config": append(`\n${JSON.stringify(await client.configure(), null, 2)}\n`); break;
      case "reload": append(`\n${JSON.stringify(await client.configure(true), null, 2)}\n`); break;
      case "auth": if (command.argument === "set") setAuth(true); else append(`\n${JSON.stringify(await client.authenticate())}\n`); break;
      case "manual": await client.setMode("manual"); append("\nManual approval mode.\n"); break;
      case "auto": await client.setMode("auto"); append("\nRestricted Auto: an independent classifier reviews source-file edits. Shell, delegation, protected paths, and other tools still require human review. Classification errors revert to Manual.\n"); break;
      case "yolo": setConfirmMode(true); break;
      case "cost": {
        const costs = (await client.result()).costs;
        append(costs ? `\n${JSON.stringify(costs, null, 2)}\n${costs.unpricedRequests ? "Total cost is unknown: some requests have no price or usage data." : "Prices are user-configured estimates, not provider invoices."}\n` : "\nUsage ledger unavailable.\n");
        break;
      }
      case "compact": { const result = await client.compact(); append(`\nCompacted ${result.previousMessages} messages. Archive: ${result.archive}\n${result.summary}\n`); break; }
      case "memory": {
        if (command.argument.startsWith("set ")) await client.remember(command.argument.slice(4));
        else if (command.argument) throw new Error("Use /memory or /memory set <trusted text>; never store credentials.");
        append(`\nSession memory: ${(await client.controls()).memory || "None"}\n`);
        break;
      }
      case "goal": {
        if (command.argument.startsWith("set ")) {
          const [objective = "", ...criteria] = command.argument.slice(4).split("|").map((value) => value.trim());
          if (!criteria.length) throw new Error("Use /goal set objective | criterion | another criterion");
          await client.setGoal(objective, criteria);
        } else if (command.argument) {
          const [state, ...note] = command.argument.split(" ");
          await client.updateGoal(goalUpdateSchema.parse({ status: state, note: note.join(" ") }));
        }
        append(`\n${JSON.stringify((await client.controls()).goal, null, 2)}\n`);
        break;
      }
      case "tools": case "extensions": {
        const inventory = await client.inventory();
        append(`\n${inventory.observed ? "Tools observed on model requests (root and delegated agents)" : "Configured extension tools; SDK tool inventory appears after the first model request"}\n${JSON.stringify(inventory, null, 2)}\nMCP, hook, and plugin configuration changes require a restart. External web tools are opt-in.\n`);
        break;
      }
      case "version": append(`\ndcode-ts ${PORT_VERSION}\n`); break;
      case "parity": append(`\n${PARITY_MILESTONES.map((stage) => `${stage.name}: ${stage.status}`).join("\n")}\n`); break;
      default: append("\nUnknown command. Use /help.\n");
    }
  }); };
  const decide = (decision: ApprovalDecision | undefined) => {
    if (!review) return;
    if (!decision) { setReview(undefined); append("\nPaused; /continue reviews pending actions.\n"); return; }
    const request = review.requests[review.request]!;
    const decisions = { ...review.decisions, [request.id]: [...(review.decisions[request.id] ?? []), decision] };
    if (review.action + 1 < request.value.actionRequests.length) setReview({ ...review, action: review.action + 1, decisions });
    else if (review.request + 1 < review.requests.length) setReview({ ...review, request: review.request + 1, action: 0, decisions });
    else { setReview(undefined); void perform(() => drive(null, decisions)); }
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busyRef.current) { append("\nCancelling; waiting for runtime and checkpoint writes to drain...\n"); void client.cancel().catch((error: unknown) => append(errorText(error))); }
      else exit();
    }
    if (key.pageUp) setScroll((value) => value + Math.max(1, size.rows - 12));
    if (key.pageDown) setScroll((value) => Math.max(0, value - Math.max(1, size.rows - 12)));
  }, { isActive: !review && !picker && !auth && !confirmMode });

  const width = Math.max(10, size.columns - 3);
  const rows = Math.max(2, size.rows - 12);
  const lines = transcript.split("\n").flatMap((line) => line ? Array.from({ length: Math.ceil(Array.from(line).length / width) }, (_, index) => Array.from(line).slice(index * width, (index + 1) * width).join("")) : [""]);
  const end = Math.max(rows, lines.length - Math.min(scroll, Math.max(0, lines.length - rows)));
  return <Box flexDirection="column" width={size.columns} height={size.rows - 1}>
    <Box justifyContent="space-between"><Text bold color="cyan">dcode-ts {PORT_VERSION}</Text><Text color={status?.mode === "yolo" ? "red" : "yellow"}>{(status?.mode ?? "manual").toUpperCase()} | HOST EXECUTION</Text></Box>
    <Text dimColor wrap="truncate">{terminalText(client.session.cwd)} | {client.session.id}</Text>
    <Text wrap="truncate">{terminalText(client.session.model)} | server {client.serverPid} | {busy ? ["-", "\\", "|", "/"][clock % 4] + " running" : status?.state ?? "connecting"} | tokens {status?.result.usage.total ?? 0} | approvals {status?.result.approvals.length ?? 0}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden" borderStyle="single" borderColor="gray" paddingX={1}>
      {confirmMode ? <ModeConfirmation confirm={(acknowledgement) => { setConfirmMode(false); if (acknowledgement) void perform(async () => { await client.setMode("yolo", acknowledgement); append("\nYOLO is active. /manual restores individual approvals.\n"); }); }} /> : auth ? <SecretField label={`API key for ${client.session.provider ?? "openai"} at ${client.session.baseUrl ?? "OpenAI"}`} submit={(key) => { setAuth(false); if (key) void perform(async () => { await client.authenticate(key); append("\nCredential saved and model refreshed.\n"); }); }} /> : review ? <ApprovalPanel key={`${review.request}:${review.action}`} request={review.requests[review.request]!} actionIndex={review.action} decide={decide} height={rows} />
        : picker ? <Picker title={picker.title} items={picker.items} choose={(value) => { const current = picker; setPicker(undefined); if (value) void perform(() => current.choose(value)); }} />
        : lines.slice(Math.max(0, end - rows), end).map((line, index) => <Text key={index} wrap="truncate">{line}</Text>)}
    </Box>
    <Text dimColor>PgUp/PgDn scroll | Ctrl+C {busy ? "cancel" : "exit"} | /threads picker | /continue resume{scroll ? " | SCROLLBACK" : ""}</Text>
    <Composer disabled={busy || !!review || !!picker || auth || confirmMode} submit={submit} />
  </Box>;
}

export async function runTerminal(client: AgentClient, directory: string): Promise<void> {
  process.stdout.write("\u001b[?1049h");
  const app = render(<TerminalApp client={client} />, { exitOnCtrlC: false, patchConsole: false, maxFps: 20 });
  try { await app.waitUntilExit(); } finally {
    app.unmount();
    process.stdout.write("\u001b[?1049l");
    const invocation = process.argv[1]?.endsWith(".ts") ? "npm run code --" : `node ${JSON.stringify(process.argv[1])}`;
    process.stdout.write(`Resume: ${invocation} --state-dir ${JSON.stringify(directory)} -r ${client.session.id}\n`);
  }
}
