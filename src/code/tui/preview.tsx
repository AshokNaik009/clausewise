import { Box, render, Text } from "ink";
import type { CodeEvent } from "../protocol/index.js";
import { ApprovalPanel } from "./widgets/ApprovalPanel.js";
import { Composer } from "./widgets/Composer.js";
import { Header } from "./widgets/Header.js";
import { HintBar, StatusBar, statusSegments } from "./widgets/StatusBar.js";
import { Transcript } from "./widgets/Transcript.js";
import { transcriptLines } from "./render/entry.js";
import { appendEntry, appendEvent, type Entry } from "./transcript.js";
import { GlyphContext, ThemeContext, glyphs as glyphSet, themeFor, type Theme } from "./theme.js";

/**
 * Renders the terminal UI against a fabricated session, with no agent server and no provider
 * credential. It mounts the same widgets the real app does, so what you see here is what the
 * app draws — only the data is invented.
 *
 *   npm run code:preview -- --theme light --charset ascii --width 100
 *   npm run code:preview -- --approval
 */

const flags = new Map<string, string>();
for (const argument of process.argv.slice(2)) {
  const [key = "", value = "true"] = argument.replace(/^--/u, "").split("=");
  flags.set(key, value);
}
const flag = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : flags.get(name) ?? fallback;
};

const theme: Theme = themeFor(flag("theme", "dark"));
const glyphs = glyphSet(flag("charset", "unicode") === "ascii" ? "ascii" : "unicode");
const columns = Number(flag("width", String(process.stdout.columns || 100)));
const rows = Number(flag("rows", String(process.stdout.rows || 34)));
const showApproval = process.argv.includes("--approval");
/** `--exit` renders one frame and quits, so the preview can be captured or diffed. */
const interactive = Boolean(process.stdin.isTTY) && !process.argv.includes("--exit");

const EVENTS: CodeEvent[] = [
  { type: "reasoning", text: "The transcript is one appended string, so nothing is addressable. That is the root cause, not the styling.", namespace: [] },
  { type: "text", text: "## Plan\n\nI'll start with `tui/app.tsx`, where the transcript is **one 300 KB string**. Steps:\n\n- Extract the reducer into `tui/transcript.ts`\n- Add [semantic theme tokens](https://example.com/theme)\n\n```ts\ntype Entry = { kind: \"tool\"; id: string }; // addressable\n```\n\n> Nothing can be styled individually today.", namespace: [] },
  { type: "tool_call", id: "1", name: "read_file", args: { file_path: "/src/code/tui/app.tsx" }, namespace: [] },
  { type: "tool_result", id: "1", name: "read_file", content: Array.from({ length: 266 }, (_, index) => `line ${index}`).join("\n"), namespace: [] },
  { type: "tool_call", id: "2", name: "edit_file", args: { file_path: "/src/code/tui/app.tsx", old_string: "const [transcript, setTranscript] = useState(snapshot.transcript);", new_string: "const [entries, setEntries] = useState<Entry[]>(snapshot.entries);" }, namespace: [] },
  { type: "tool_result", id: "2", name: "edit_file", content: "Updated file", namespace: [] },
  { type: "tool_call", id: "3", name: "execute", args: { command: "npm run check" }, namespace: [] },
  { type: "tool_result", id: "3", name: "execute", content: "src/code/tui/app.tsx(46,7): error TS2339: Property 'transcript' does not exist\n\n[Command failed with exit code 2]", status: "error", namespace: [] },
  { type: "tool_call", id: "4", name: "grep", args: { pattern: "wrapTerminal", path: "src/code" }, namespace: [] },
  { type: "tool_result", id: "4", name: "grep", content: "src/code/tui/layout.ts:11\nsrc/code/tui/render/lines.ts:1", namespace: [] },
  { type: "text", text: "Auditing the widgets for hardcoded colours.", namespace: ["task", "general-purpose"] },
  { type: "policy", mode: "plan", message: "Plan mode rejected this action batch; the agent keeps planning." },
  { type: "tool_call", id: "5", name: "write_file", args: { file_path: "/src/code/tui/theme.ts", content: "export interface Theme {\n  accent?: string;\n}" }, namespace: [] },
];

let entries: Entry[] = appendEntry([], { kind: "user", text: "Why does the UI read as basic? Plan the fix before changing anything.", at: Date.now() });
for (const event of EVENTS) entries = appendEvent(entries, event);
entries = appendEntry(entries, { kind: "status", text: "interrupted", at: Date.now() });

const request = {
  id: "interrupt-1",
  value: {
    actionRequests: [{ name: "edit_file", args: { file_path: "/src/code/tui/app.tsx", old_string: "const accent = theme === \"plain\" ? undefined : \"cyan\";", new_string: "const theme = themeFor(snapshot.preferences.theme);" } }],
    reviewConfigs: [{ actionName: "edit_file", allowedDecisions: ["approve", "reject", "edit"] as ("approve" | "reject" | "edit")[] }],
  },
};

function Preview() {
  const width = Math.max(4, columns - 4);
  const viewport = Math.max(1, rows - 14);
  const lines = transcriptLines(entries, { width, theme, glyphs, spinner: glyphs.spinner[0]! });
  const segments = statusSegments({
    mode: "plan", activity: `${glyphs.spinner[2]} running`, connection: "connected",
    queued: 2, paused: true, model: "gpt-5-codex", branch: "spec-and-scaffold",
    tokens: 128_400, costUsd: 0.4231, cwd: process.cwd(), width,
  }, glyphs);
  return <ThemeContext.Provider value={theme}><GlyphContext.Provider value={glyphs}>
    <Box flexDirection="column" width={columns}>
      <Header mode="plan" title={process.cwd()} sessionId="7f3a9c21-4d18-4b0e-9a52-1c6f8e0d3b47" width={columns} />
      <Box flexDirection="column" height={viewport + 2} overflow="hidden" borderStyle="single" borderColor={theme.border ?? "gray"} paddingX={1}>
        {showApproval && interactive
          ? <ApprovalPanel request={request} actionIndex={0} decide={() => process.exit(0)} height={viewport} lineNumbers={false} />
          : <Transcript lines={lines} from={Math.max(0, lines.length - viewport)} to={lines.length} />}
      </Box>
      <StatusBar segments={segments} width={columns} />
      <HintBar busy scroll={false} position={`${lines.length}/${lines.length}`} />
      <Composer disabled={!interactive} submit={() => true} draft={{ text: interactive ? "" : "/pl", revision: 0 }} onDraft={() => undefined} queued files={["src/code/tui/app.tsx", "src/code/tui/theme.ts", "src/code/tui/transcript.ts"]} width={width} />
      {interactive ? <Text dimColor>Preview: no agent server is attached. Type / or @ to see completions. Ctrl+C exits.</Text> : null}
    </Box>
  </GlyphContext.Provider></ThemeContext.Provider>;
}

if (showApproval && !interactive) process.stdout.write("--approval needs a real terminal: the panel enables raw-mode input.\n");
const app = render(<Preview />, { patchConsole: false });
if (interactive) await app.waitUntilExit();
else { await new Promise((resolve) => setTimeout(resolve, 50)); app.unmount(); }
