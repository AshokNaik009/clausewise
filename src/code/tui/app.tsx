import { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, useApp, useInput, useStdout } from "ink";
import { AgentClient } from "../client/agent-client.js";
import { PromptQueue } from "../client/prompt-queue.js";
import { parseCommand } from "../cli/commands.js";
import type { ApprovalDecision, ApprovalDecisions, ApprovalRequest } from "../runtime/approvals.js";
import { errorText, terminalText } from "../shared/output.js";
import type { CodeEvent, ServerStatus, TurnResult } from "../protocol/index.js";
import type { CodeSettings } from "../config/configuration.js";
import { ApprovalPanel } from "./widgets/ApprovalPanel.js";
import { Composer } from "./widgets/Composer.js";
import { Header } from "./widgets/Header.js";
import { HintBar, StatusBar, statusSegments } from "./widgets/StatusBar.js";
import { Transcript } from "./widgets/Transcript.js";
import { Picker, type PickerItem } from "./widgets/Picker.js";
import { SecretField } from "./widgets/SecretField.js";
import { ModeConfirmation } from "./widgets/ModeConfirmation.js";
import { ConfirmationPanel } from "./widgets/ConfirmationPanel.js";
import { executeCommand } from "./commands.js";
import { editPrompt } from "./desktop.js";
import { indexFiles } from "./files.js";
import { gitBranch } from "./git.js";
import { transcriptLines } from "./render/entry.js";
import { appendEntry, appendEvent, type Entry } from "./transcript.js";
import { GlyphContext, ThemeContext, glyphs as glyphSet, resolveCharset, themeFor } from "./theme.js";
import { validTerminalSequence } from "../extensions/hook-output.js";

interface Review { requests: ApprovalRequest[]; request: number; action: number; decisions: ApprovalDecisions }
interface Selection { title: string; items: PickerItem[]; choose: (value: string) => Promise<void>; command?: string }
interface TerminalSnapshot { entries: Entry[]; draft: string; history: string[]; notices: string[]; queue: PromptQueue; preferences: CodeSettings; update?: import("../cli/updates.js").UpdatePlan }

function TerminalApp({ client, snapshot }: { client: AgentClient; snapshot: TerminalSnapshot }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [status, setStatus] = useState<ServerStatus>();
  const [entries, setEntries] = useState<Entry[]>(snapshot.entries);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const leaving = useRef(false);
  const [scroll, setScroll] = useState(0);
  const [review, setReview] = useState<Review>();
  const [picker, setPicker] = useState<Selection>();
  const [auth, setAuth] = useState(false);
  const [confirmMode, setConfirmMode] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; text: string; accept: () => Promise<void> }>();
  const [clock, setClock] = useState(0);
  const [queueTick, setQueueTick] = useState(0);
  const [branch, setBranch] = useState<string>();
  const [files, setFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState({ text: snapshot.draft, revision: 0 });
  const queue = snapshot.queue;
  const changedQueue = () => setQueueTick((value) => value + 1);
  const commit = (next: Entry[]) => { snapshot.entries = next; setEntries(next); };
  const add = (entry: Entry) => commit(appendEntry(snapshot.entries, entry));
  /** Slash commands print blocks of text; they become notices so they stay addressable. */
  const print = (text: string) => { const trimmed = terminalText(text).replace(/^\n+|\n+$/gu, ""); if (trimmed) add({ kind: "notice", text: trimmed, level: "info", at: Date.now() }); };
  const notice = (message: string) => {
    snapshot.notices = [...snapshot.notices, terminalText(message)].slice(-100);
    add({ kind: "notice", text: terminalText(message), level: "info", at: Date.now() });
  };
  const fillDraft = (text: string) => { snapshot.draft = text; setDraft((value) => ({ text, revision: value.revision + 1 })); };
  const refresh = async () => {
    if (leaving.current) return;
    const current = await client.status();
    setStatus(current);
    if (current.state !== "running" && current.state !== "cancelling") snapshot.preferences = (await client.configure()).settings;
  };
  const finishResult = (result: TurnResult) => {
    if (result.status !== "completed") { queue.paused = true; changedQueue(); }
    if (result.approvals.length) setReview({ requests: result.approvals, request: 0, action: 0, decisions: {} });
    add({ kind: "status", text: result.status, at: Date.now() });
  };
  const onEvent = (event: CodeEvent) => {
    if (event.type === "notice" || event.type === "policy") {
      const message = event.type === "notice" ? event.message : `[${event.mode}] ${event.message}`;
      snapshot.notices = [...snapshot.notices, terminalText(message)].slice(-100);
    }
    if (event.type === "terminal" && stdout.isTTY && snapshot.preferences.terminalEscapes !== false && validTerminalSequence(event.sequence)) { stdout.write(event.sequence); return; }
    if (event.type === "policy") setStatus((current) => current ? { ...current, mode: event.mode } : current);
    if (event.type === "reasoning" && snapshot.preferences.showReasoning === false) return;
    commit(appendEvent(snapshot.entries, event));
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busyRef.current || leaving.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await operation(); }
    catch (error) { if (!leaving.current) { queue.paused = true; changedQueue(); notice(errorText(error)); } }
    finally {
      if (!leaving.current) {
        try { await refresh(); } catch (error) { notice(errorText(error)); }
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    const timer = setInterval(() => setClock((value) => value + 1), 200);
    const unsubscribe = client.subscribe(onEvent, notice);
    const terminate = () => { queue.paused = true; leaving.current = true; exit(); };
    process.once("SIGTERM", terminate);
    void indexFiles(client.session.cwd).then(setFiles).catch(() => undefined);
    void perform(async () => {
      const state = await client.status();
      const history = await client.history();
      snapshot.history = [...new Set([...history.filter(({ role }) => role === "human").map(({ text }) => text), ...snapshot.history])].slice(-200);
      if (!snapshot.entries.length) {
        commit(history.reduce<Entry[]>((list, message) => appendEntry(list, message.role === "human"
          ? { kind: "user", text: terminalText(message.text), at: Date.now() }
          : { kind: "assistant", text: terminalText(message.text), at: Date.now(), namespace: [] }), snapshot.entries));
      }
      if (state.runId) { notice("Attached to an existing run; waiting without resubmitting it."); finishResult(await client.wait()); }
      else if (state.result.approvals.length) finishResult(state.result);
    });
    return () => { unsubscribe(); stdout.off("resize", resize); clearInterval(timer); process.off("SIGTERM", terminate); };
  }, []);
  useEffect(() => {
    if (snapshot.preferences.hideGitBranch) { setBranch(undefined); return; }
    void gitBranch(client.session.cwd).then(setBranch).catch(() => undefined);
  }, [clock >> 4, client.session.cwd, snapshot.preferences.hideGitBranch]);

  const drive = async (prompt: string | null, decisions?: ApprovalDecisions) => {
    setScroll(0);
    finishResult(await client.turn(prompt, { ...(decisions ? { decisions } : {}) }));
  };
  const select = async (id: string | null) => {
    if (queue.size) { queue.paused = true; notice("Queue paused at the session boundary. It remains bound to the original session."); }
    const next = await client.select(id);
    commit([{ kind: "notice", text: `Session ${next.session.id}`, level: "info", at: Date.now() }]);
    for (const message of await client.history()) {
      add(message.role === "human"
        ? { kind: "user", text: terminalText(message.text), at: Date.now() }
        : { kind: "assistant", text: terminalText(message.text), at: Date.now(), namespace: [] });
    }
    setStatus(next); setScroll(0); setReview(undefined);
  };
  const pick = (title: string, items: PickerItem[], choose: (value: string) => Promise<void>) => setPicker({ title, items, choose });
  const dispatch = async (text: string) => {
    const command = parseCommand(text.trim());
    if (!command) {
      add({ kind: "user", text: terminalText(text), at: Date.now() });
      /** `!cmd` is a shorthand for proposing a shell command; it still goes through approvals. */
      const shell = text.trim().startsWith("!") ? text.trim().slice(1).trim() : "";
      await drive(shell ? `Run exactly this shell command with the execute tool and report its output. Do not modify it, and take no other action: ${shell}` : text);
      return;
    }
    if (command.name === "editor") { leaving.current = true; exit("editor"); return; }
    await executeCommand(command.name, command.argument, {
      client, print, select, run: drive,
      installUpdate: async (plan) => { if (queue.size || snapshot.draft.trim()) throw new Error("Save or clear queued prompts and the composer draft before updating"); snapshot.update = plan; leaving.current = true; exit("update"); },
      pick: (title, items, choose, deferred) => setPicker({ title, items, choose, ...(deferred === null ? {} : { command: deferred ?? (command.name === "threads" ? "/resume" : command.name === "auto" ? "/auto model" : `/${command.name}`) }) }),
      confirm: (title, text, accept) => setConfirmation({ title, text, accept }), auth: () => setAuth(true), yolo: () => setConfirmMode(true),
    });
  };
  const immediate = async (name: string | null, argument: string, text: string) => {
    switch (name) {
      case "quit": leaving.current = true; exit(); return;
      case "cancel": queue.paused = true; changedQueue(); await client.cancel(); await refresh(); return;
      case "continue": if (busyRef.current) throw new Error("A run is already active"); await perform(() => drive(null)); return;
      case "detach":
        if (queue.size || (snapshot.draft.trim() && snapshot.draft.trim() !== text.trim())) throw new Error("Clear or save queued prompts and the composer draft before detaching; they are client-local");
        leaving.current = true; await client.detach(); exit(); return;
      case "restart":
        queue.paused = true; changedQueue(); await client.cancel(); leaving.current = true; exit("restart"); return;
      case "force-clear":
        queue.paused = true; changedQueue(); await client.cancel();
        while (busyRef.current) await new Promise((resolve) => setTimeout(resolve, 20));
        await perform(() => select(null)); return;
      case "prompts":
        pick("Recall a prompt (does not send)", snapshot.history.map((text, index) => ({ value: String(index), label: text.replace(/\n/gu, " ").slice(0, 200) })), async (value) => fillDraft(snapshot.history[Number(value)] ?? "")); return;
      case "notifications": print(snapshot.notices.join("\n") || "No notifications"); return;
      case "queue": {
        const [action, index] = argument.split(/\s+/u);
        if (action === "pause") queue.paused = true;
        else if (action === "resume") queue.paused = false;
        else if (action === "clear") queue.clear();
        else if (action === "edit" || action === "remove") { const entry = queue.remove(Number(index)); if (action === "edit") fillDraft(entry.text); }
        else if (action) throw new Error("Use /queue [pause|resume|clear|edit N|remove N]");
        changedQueue();
        print(`Queue ${queue.paused ? "paused" : "ready"}:\n${queue.snapshot().map((entry, index) => `${index + 1}. ${entry.text}`).join("\n") || "Empty"}`); return;
      }
      default: await dispatch(text); if (name === "manual" || name === "plan") await refresh();
    }
  };
  const submit = (text: string): boolean => {
    const command = parseCommand(text.trim());
    try {
      if (command?.bypass === "always" || (command?.bypass === "picker" && !command.argument)) {
        void immediate(command.name, command.argument, text).catch((error: unknown) => notice(errorText(error)));
      } else if (busyRef.current || queue.size || queue.paused || status?.state === "incomplete" || status?.state === "awaiting_approval") {
        queue.push(client.session.id, text); changedQueue();
        notice(`Input queued (${queue.size}). /queue edits or pauses it.`);
      } else void perform(() => dispatch(text));
      if (!command) snapshot.history = [...snapshot.history, text].slice(-200);
      return true;
    } catch (error) { notice(errorText(error)); return false; }
  };
  useEffect(() => {
    if (busy || busyRef.current || leaving.current || review || picker || auth || confirmMode || !!confirmation || !status || status.state !== "idle" || queue.paused || client.state !== "connected") return;
    try { const next = queue.take(client.session.id); if (next) { changedQueue(); void perform(() => dispatch(next.text)); } }
    catch (error) { notice(errorText(error)); }
  }, [busy, status, queueTick, review, picker, auth, confirmMode, confirmation]);

  const decide = (decision: ApprovalDecision | undefined) => {
    if (!review) return;
    if (!decision) { setReview(undefined); queue.paused = true; changedQueue(); notice("Paused; /continue reviews pending actions."); return; }
    const request = review.requests[review.request]!;
    const decisions = { ...review.decisions, [request.id]: [...(review.decisions[request.id] ?? []), decision] };
    if (review.action + 1 < request.value.actionRequests.length) setReview({ ...review, action: review.action + 1, decisions });
    else if (review.request + 1 < review.requests.length) setReview({ ...review, request: review.request + 1, action: 0, decisions });
    else { setReview(undefined); void perform(() => drive(null, decisions)); }
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      queue.paused = true; changedQueue();
      if (busyRef.current) { notice("Cancelling; waiting for runtime and checkpoint writes to drain..."); void client.cancel().catch((error: unknown) => notice(errorText(error))); }
      else { leaving.current = true; exit(); }
    }
    if (key.ctrl && input === "g" && !busyRef.current) { leaving.current = true; exit("editor"); }
    if (key.pageUp) setScroll((value) => value + Math.max(1, size.rows - 12));
    if (key.pageDown) setScroll((value) => Math.max(0, value - Math.max(1, size.rows - 12)));
  }, { isActive: !review && !picker && !auth && !confirmMode && !confirmation });

  const width = Math.max(4, size.columns - 4);
  const rows = Math.max(1, size.rows - 14);
  const theme = themeFor(snapshot.preferences.theme);
  const glyphs = glyphSet(resolveCharset(snapshot.preferences.charset));
  const spinner = glyphs.spinner[clock % glyphs.spinner.length]!;
  const timestamps = snapshot.preferences.timestamps === true;
  const lines = useMemo(
    () => transcriptLines(entries, { width, theme, glyphs, timestamps, spinner }),
    [entries, width, theme, glyphs, timestamps, spinner],
  );
  const end = Math.max(rows, lines.length - Math.min(scroll, Math.max(0, lines.length - rows)));
  const segments = statusSegments({
    mode: status?.mode ?? "manual",
    activity: busy ? `${spinner} running` : status?.state ?? "connecting",
    connection: client.state,
    queued: queue.size,
    paused: queue.paused,
    model: terminalText(client.session.model),
    ...(branch ? { branch } : {}),
    tokens: status?.result.usage.total ?? 0,
    ...(status?.result.costs ? { costUsd: status.result.costs.knownCostUsd } : {}),
    ...(snapshot.preferences.hideCwd ? {} : { cwd: client.session.cwd }),
    width,
  }, glyphs);
  return <ThemeContext.Provider value={theme}><GlyphContext.Provider value={glyphs}>
    <Box flexDirection="column" width={size.columns} height={Math.max(8, size.rows - 1)}>
      <Header mode={status?.mode ?? "manual"} title={client.session.title ?? (snapshot.preferences.hideCwd ? "Working directory hidden" : client.session.cwd)} sessionId={client.session.id} width={size.columns} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden" borderStyle="single" borderColor={theme.border ?? "gray"} paddingX={1}>
        {confirmation ? <ConfirmationPanel title={confirmation.title} text={confirmation.text} choose={(accepted) => { const current = confirmation; setConfirmation(undefined); if (accepted) void perform(current.accept); }} /> : confirmMode ? <ModeConfirmation confirm={(acknowledgement) => { setConfirmMode(false); if (acknowledgement) void perform(async () => { await client.setMode("yolo", acknowledgement); notice("YOLO is active. /manual restores individual approvals."); }); }} />
          : auth ? <SecretField label={`API key for ${client.session.provider ?? "openai"}`} submit={(key) => { setAuth(false); if (key) void perform(async () => { await client.authenticate(key); notice("Credential saved and model refreshed."); }); }} />
          : review ? <ApprovalPanel key={`${review.request}:${review.action}`} request={review.requests[review.request]!} actionIndex={review.action} decide={decide} height={rows} lineNumbers={snapshot.preferences.lineNumbers ?? false} loadPreview={() => client.preview(review.requests[review.request]!.id, review.action)} />
          : picker ? <Picker title={picker.title} items={picker.items} choose={(value) => { const current = picker; setPicker(undefined); if (value !== undefined) { if (current.command) submit(`${current.command} ${value}`); else void current.choose(value).catch((error: unknown) => notice(errorText(error))); } }} />
          : <Transcript lines={lines} from={Math.max(0, end - rows)} to={end} />}
      </Box>
      <StatusBar segments={segments} width={size.columns} />
      <HintBar busy={busy} scroll={scroll > 0} {...(snapshot.preferences.scrollbar ? { position: `${Math.min(end, lines.length)}/${lines.length}` } : {})} />
      <Composer disabled={!!review || !!picker || auth || confirmMode || !!confirmation} submit={submit} draft={draft} onDraft={(text) => { snapshot.draft = text; }} history={snapshot.history} queued={busy || queue.size > 0 || queue.paused} files={files} width={width} />
    </Box>
  </GlyphContext.Provider></ThemeContext.Provider>;
}

export async function runTerminal(initial: AgentClient, directory: string): Promise<void> {
  let client = initial;
  const snapshot: TerminalSnapshot = { entries: [], draft: "", history: [], notices: [], queue: new PromptQueue(), preferences: {} };
  const record = (text: string) => { snapshot.entries = appendEntry(snapshot.entries, { kind: "notice", text, level: "info", at: Date.now() }); };
  try {
    for (;;) {
      process.stdout.write("\u001b[?1049h");
      const app = render(<TerminalApp client={client} snapshot={snapshot} />, { exitOnCtrlC: false, patchConsole: false, maxFps: 20 });
      let action: unknown;
      try { action = await app.waitUntilExit(); }
      finally { app.unmount(); process.stdout.write("\u001b[?1049l"); }
      if (action === "update" && snapshot.update) {
        await client.close();
        const { ApplicationUpdates } = await import("../cli/updates.js");
        const plan = snapshot.update;
        await new ApplicationUpdates(snapshot.preferences).apply(plan, `Update ${plan.package} to ${plan.version}`);
        process.stdout.write(`Updated to ${plan.version}. Restart dcode-ts to use the new version.\n`);
        break;
      }
      if (action === "editor") {
        try { snapshot.draft = await editPrompt(snapshot.draft, client.session.cwd); }
        catch (error) { record(errorText(error)); }
        continue;
      }
      if (action === "restart") {
        const state = await client.status();
        await client.close();
        client = await AgentClient.start(directory, state.session.id, state.options);
        record("Server restarted. No prompts or tools were replayed; /continue is explicit. Queue paused.");
        continue;
      }
      break;
    }
  } finally {
    if (!client.isDetached && !snapshot.update && snapshot.preferences.showUsageStats !== false) {
      const result = await client.result().catch(() => undefined);
      if (result) process.stdout.write(`Retained token usage: ${result.usage.total}; known estimated cost: ${result.costs ? `$${result.costs.knownCostUsd.toFixed(4)}` : "unknown"}.\n`);
    }
    if (client !== initial) await client.close();
    const invocation = process.argv[1]?.endsWith(".ts") ? "npm run code --" : `node ${JSON.stringify(process.argv[1])}`;
    process.stdout.write(terminalText(client.isDetached ? `Attach within 15 minutes: ${invocation} --state-dir ${JSON.stringify(directory)} --attach ${client.serverId}\n` : `Resume: ${invocation} --state-dir ${JSON.stringify(directory)} -r ${client.session.id}\n`));
  }
}
