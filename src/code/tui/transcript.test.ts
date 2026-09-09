import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeEvent } from "../protocol/index.js";
import { appendEvent, MAX_ENTRIES, toPlainText, type Entry } from "./transcript.js";
import { transcriptLines } from "./render/entry.js";
import { lineText, textWidth, wrapSpans, wrapSpansFixed } from "./render/lines.js";
import { markdownLines } from "./render/markdown.js";
import { glyphs, resolveCharset, THEMES } from "./theme.js";
import { fitSegments } from "./widgets/StatusBar.js";
import { indexFiles, matchFiles } from "./files.js";
import { gitBranch } from "./git.js";

const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), "dcode-tui-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fold = (events: CodeEvent[], start: Entry[] = []) => events.reduce((entries, event) => appendEvent(entries, event, 1000), start);
const options = { width: 60, theme: THEMES.dark, glyphs: glyphs("unicode") };
const render = (entries: Entry[], width = 60, theme = THEMES.dark) => transcriptLines(entries, { ...options, width, theme }).map(lineText);

describe("transcript reducer", () => {
  it("coalesces consecutive assistant text into one entry", () => {
    const entries = fold([
      { type: "text", text: "Hello ", namespace: [] },
      { type: "text", text: "world", namespace: [] },
      { type: "text", text: "nested", namespace: ["task"] },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "Hello world", namespace: [] });
    expect(entries[1]).toMatchObject({ kind: "assistant", text: "nested", namespace: ["task"] });
  });

  it("merges a tool result into its call by id instead of emitting a second entry", () => {
    const entries = fold([
      { type: "tool_call", id: "call-1", name: "read_file", args: { file_path: "/a.ts" }, namespace: [] },
      { type: "tool_call", id: "call-2", name: "execute", args: { command: "ls" }, namespace: [] },
      { type: "tool_result", id: "call-2", name: "execute", content: "boom", status: "error", namespace: [] },
      { type: "tool_result", id: "call-1", name: "read_file", content: "ok", namespace: [] },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "tool", name: "read_file", result: "ok", state: "ok" });
    expect(entries[1]).toMatchObject({ kind: "tool", name: "execute", result: "boom", state: "error" });
  });

  it("keeps an unmatched result addressable rather than dropping it", () => {
    const entries = fold([{ type: "tool_result", id: "orphan", name: "grep", content: "match", namespace: [] }]);
    expect(entries).toMatchObject([{ kind: "tool", name: "grep", result: "match", state: "ok", args: {} }]);
  });

  it("settles a reasoning entry when the answer starts", () => {
    const entries = fold([
      { type: "reasoning", text: "weighing ", namespace: [] },
      { type: "reasoning", text: "options", namespace: [] },
      { type: "text", text: "Answer", namespace: [] },
    ]);
    expect(entries).toMatchObject([
      { kind: "reasoning", text: "weighing options", settled: true },
      { kind: "assistant", text: "Answer" },
    ]);
  });

  it("caps by entry count and keeps the newest", () => {
    const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, index): CodeEvent => ({ type: "tool_call", id: `id-${index}`, name: "ls", args: {}, namespace: [] }));
    const entries = fold(many);
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries.at(-1)).toMatchObject({ id: `id-${MAX_ENTRIES + 49}` });
  });

  it("projects to plain text for consumers that need a flat transcript", () => {
    const entries = fold([{ type: "text", text: "done", namespace: [] }], [{ kind: "user", text: "go", at: 1 }]);
    expect(toPlainText(entries)).toBe("You: go\n\ndone");
  });
});

describe("transcript rendering", () => {
  it("renders a real diff for a proposed edit", () => {
    const entries = fold([{ type: "tool_call", id: "e", name: "edit_file", args: { file_path: "/src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, namespace: [] }]);
    const lines = render(entries);
    expect(lines.some((line) => line.includes("edit_file") && line.includes("/src/a.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("+1 -1"))).toBe(true);
    expect(lines.some((line) => line.includes("- const a = 1;"))).toBe(true);
    expect(lines.some((line) => line.includes("+ const a = 2;"))).toBe(true);
  });

  it("shows the shell command and its output for execute", () => {
    const entries = fold([
      { type: "tool_call", id: "x", name: "execute", args: { command: "npm run check" }, namespace: [] },
      { type: "tool_result", id: "x", name: "execute", content: "all good", namespace: [] },
    ]);
    const lines = render(entries);
    expect(lines.some((line) => line.includes("$ npm run check"))).toBe(true);
    expect(lines.some((line) => line.includes("all good"))).toBe(true);
  });

  it("keeps the exit-code trailer visible past the collapse limit", () => {
    const output = `${Array.from({ length: 60 }, (_, index) => `noise line ${index}`).join("\n")}\n[Command failed with exit code 2]`;
    const entries = fold([
      { type: "tool_call", id: "x", name: "execute", args: { command: "npm test" }, namespace: [] },
      { type: "tool_result", id: "x", name: "execute", content: output, status: "error", namespace: [] },
    ]);
    const lines = render(entries);
    expect(lines.some((line) => line.includes("more lines"))).toBe(true);
    expect(lines.at(-1)).toContain("[Command failed with exit code 2]");
  });

  it("summarises a read and indents subagent output by namespace", () => {
    const entries = fold([
      { type: "tool_call", id: "r", name: "read_file", args: { file_path: "/src/code/tui/app.tsx" }, namespace: [] },
      { type: "tool_result", id: "r", name: "read_file", content: "a\nb\nc", namespace: [] },
      { type: "text", text: "child says hi", namespace: ["task", "general-purpose"] },
    ]);
    const lines = render(entries);
    expect(lines.some((line) => line.includes("/src/code/tui/app.tsx (3 lines)"))).toBe(true);
    expect(lines.some((line) => line.startsWith("    child says hi"))).toBe(true);
  });

  it("colours nothing under the plain theme", () => {
    const entries = fold([{ type: "tool_call", id: "e", name: "edit_file", args: { file_path: "/a", old_string: "x", new_string: "y" }, namespace: [] }]);
    const styled = transcriptLines(entries, { ...options, theme: THEMES.plain });
    expect(styled.flatMap((line) => line.spans).some((span) => span.color !== undefined)).toBe(false);
    const coloured = transcriptLines(entries, { ...options, theme: THEMES.dark });
    expect(coloured.flatMap((line) => line.spans).some((span) => span.color !== undefined)).toBe(true);
  });

  it("never renders a row wider than the viewport", () => {
    const entries = fold([
      { type: "text", text: `# Heading\n\nA ${"very".repeat(40)}long unbreakable token and some ordinary prose that has to wrap.\n\n- item one\n- item two`, namespace: [] },
      { type: "tool_call", id: "g", name: "grep", args: { pattern: "x".repeat(200) }, namespace: [] },
    ]);
    for (const width of [24, 40, 80, 200]) {
      for (const line of render(entries, width)) expect(textWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("reuses wrapped lines for unchanged entries", () => {
    const entries = fold([{ type: "text", text: "stable", namespace: [] }]);
    expect(transcriptLines(entries, options)[0]).toBe(transcriptLines(entries, options)[0]);
  });
});

describe("markdown and wrapping", () => {
  it("styles headings, code, emphasis, and links", () => {
    const lines = markdownLines("# Title\n\n**bold** and `code` and [docs](https://example.com)\n\n```ts\nconst x = 1; // note\n```", 60, THEMES.dark, glyphs("unicode"));
    const spans = lines.flatMap((line) => line.spans);
    expect(spans.find((span) => span.text === "Title")).toMatchObject({ bold: true, color: THEMES.dark.mdHeading });
    expect(spans.find((span) => span.text === "bold")).toMatchObject({ bold: true });
    expect(spans.find((span) => span.text === "code")).toMatchObject({ color: THEMES.dark.mdCode });
    expect(spans.find((span) => span.text === "docs")).toMatchObject({ underline: true });
    expect(spans.find((span) => span.text === "const")).toMatchObject({ color: THEMES.dark.mdCode });
    expect(spans.find((span) => span.text === "// note")).toMatchObject({ dimColor: true });
  });

  it("falls back to ASCII glyphs without corrupting the layout", () => {
    expect(resolveCharset("auto", { LANG: "C" })).toBe("ascii");
    expect(resolveCharset("auto", { LANG: "en_US.UTF-8" })).toBe("unicode");
    expect(resolveCharset("unicode", { LANG: "C" })).toBe("unicode");
    const entries = fold([
      { type: "tool_call", id: "a", name: "ls", args: {}, namespace: [] },
      { type: "tool_result", id: "a", name: "ls", content: "src\ntest", namespace: [] },
      { type: "text", text: "# Heading\n\n- point\n\n> quoted", namespace: [] },
    ]);
    const ascii = transcriptLines(entries, { ...options, glyphs: glyphs("ascii") }).map(lineText);
    expect(ascii[0]?.startsWith("* ls")).toBe(true);
    for (const line of ascii) expect(line).toMatch(/^[\x20-\x7e]*$/u);
  });

  it("hard-wraps styled code without losing characters", () => {
    const wrapped = wrapSpansFixed([{ text: "abcdefghij", bold: true }, { text: "klmno" }], 4);
    expect(wrapped.map(lineText).join("")).toBe("abcdefghijklmno");
    for (const line of wrapped) expect(textWidth(lineText(line))).toBeLessThanOrEqual(4);
  });

  it("keeps a hanging indent on wrapped prose", () => {
    const wrapped = wrapSpans([{ text: "one two three four five" }], 12, "  ");
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(lineText(line).startsWith("  ")).toBe(true);
  });
});

describe("footer", () => {
  it("drops the lowest-priority segments as the terminal narrows", () => {
    const segments = [
      { text: "MANUAL", priority: 100 },
      { text: "idle", priority: 95 },
      { text: "gpt-4.1", priority: 70 },
      { text: "/very/long/working/directory", priority: 10 },
    ];
    expect(fitSegments(segments, 200).map(({ text }) => text)).toEqual(segments.map(({ text }) => text));
    expect(fitSegments(segments, 20).map(({ text }) => text)).toEqual(["MANUAL", "idle"]);
    expect(fitSegments(segments, 1).map(({ text }) => text)).toEqual(["MANUAL"]);
  });
});

describe("composer file index", () => {
  it("indexes repository files and ranks basename matches first", async () => {
    const root = await directory();
    await mkdir(join(root, "src", "code"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "code", "app.tsx"), "x");
    await writeFile(join(root, "src", "apply-notes.md"), "x");
    await writeFile(join(root, "node_modules", "pkg", "app.tsx"), "x");
    const index = await indexFiles(root);
    expect(index).toContain("src/code/app.tsx");
    expect(index.some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(matchFiles(index, "app.tsx")[0]).toBe("src/code/app.tsx");
  });
});

describe("git branch", () => {
  it("reads HEAD without spawning git, and reports nothing outside a repository", async () => {
    const root = await directory();
    expect(await gitBranch(root, 1)).toBeUndefined();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/spec-and-scaffold\n");
    expect(await gitBranch(root, 100_000)).toBe("spec-and-scaffold");
    await writeFile(join(root, ".git", "HEAD"), "9f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n");
    expect(await gitBranch(root, 200_000)).toBe("9f2b1c4");
  });
});
