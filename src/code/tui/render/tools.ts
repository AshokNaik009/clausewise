import { diffStat, replacementDiff, unifiedDiff } from "../../shared/diff.js";
import type { Glyphs, Theme } from "../theme.js";
import type { Entry } from "../transcript.js";
import { truncate, wrapFixed, wrapSpans, type Span, type Style, type StyledLine } from "./lines.js";

export type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** Detail rows past this are folded behind a "… N more lines" marker. */
export const COLLAPSE_AFTER = 20;
/** Exit-code trailer the runtime appends to `execute` output. */
const EXIT_TRAILER = /\n?\[Command (succeeded|failed) with exit code (-?\d+)\]\s*$/u;

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const args = (entry: ToolEntry, ...keys: string[]): string | undefined => {
  for (const key of keys) { const value = text(entry.args[key]); if (value !== undefined) return value; }
  return undefined;
};

function marker(entry: ToolEntry, theme: Theme, glyphs: Glyphs): Span {
  if (entry.state === "pending") return { text: `${glyphs.pending} `, dimColor: true };
  if (entry.state === "error") return { text: `${glyphs.error} `, ...(theme.error ? { color: theme.error } : {}) };
  return { text: `${glyphs.call} `, ...(theme.toolName ? { color: theme.toolName } : {}) };
}

function collapse(lines: StyledLine[], glyphs: Glyphs, limit = COLLAPSE_AFTER): StyledLine[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), { spans: [{ text: `  ${glyphs.ellipsis} ${lines.length - limit} more lines`, dimColor: true }] }];
}

function detailStyle(entry: ToolEntry, theme: Theme): Style {
  if (entry.state === "error") return theme.error ? { color: theme.error } : {};
  return theme.toolOutput ? { color: theme.toolOutput } : { dimColor: true };
}

function diffLines(entry: ToolEntry, width: number, theme: Theme, glyphs: Glyphs, indent: string): StyledLine[] | undefined {
  const path = args(entry, "file_path", "path");
  if (path === undefined) return undefined;
  const lines = entry.name === "write_file"
    ? unifiedDiff(path, "", text(entry.args.content) ?? "", { exists: false })
    : text(entry.args.old_string) !== undefined && text(entry.args.new_string) !== undefined
      ? replacementDiff(path, entry.args.old_string as string, entry.args.new_string as string)
      : undefined;
  if (!lines) return undefined;
  const stat = diffStat(lines);
  const body = lines.slice(2).flatMap((line) => wrapFixed(line, width, line.startsWith("+ ") ? theme.diffAdd ? { color: theme.diffAdd } : {} : line.startsWith("- ") ? theme.diffRemove ? { color: theme.diffRemove } : {} : { dimColor: true }, `${indent}  `));
  return [...wrapSpans([{ text: `+${stat.added} -${stat.removed}`, dimColor: true }], width, `${indent}  `), ...collapse(body, glyphs)];
}

function summary(entry: ToolEntry): string {
  const lineCount = entry.result === undefined ? 0 : entry.result.split("\n").length;
  switch (entry.name) {
    case "read_file": {
      const path = args(entry, "file_path", "path") ?? "";
      return entry.result === undefined ? path : `${path} (${lineCount} lines)`;
    }
    case "ls": return args(entry, "path", "directory") ?? "/";
    case "glob": case "grep": {
      const pattern = args(entry, "pattern", "query") ?? "";
      const where = args(entry, "path", "directory");
      const matches = entry.result === undefined ? "" : ` (${entry.result.trim() ? lineCount : 0} matches)`;
      return `${pattern}${where ? ` in ${where}` : ""}${matches}`;
    }
    case "execute": return args(entry, "command", "cmd") ?? "";
    case "write_file": case "edit_file": case "delete": return args(entry, "file_path", "path") ?? "";
    case "task": return args(entry, "subagent_type", "description", "name") ?? "";
    default: {
      const json = JSON.stringify(entry.args);
      return json === "{}" ? "" : json;
    }
  }
}

function detail(entry: ToolEntry, width: number, theme: Theme, glyphs: Glyphs, indent: string): StyledLine[] {
  const style = detailStyle(entry, theme);
  const nested = `${indent}  `;
  switch (entry.name) {
    case "write_file": case "edit_file": {
      const diff = diffLines(entry, width, theme, glyphs, indent);
      if (diff) return diff;
      break;
    }
    case "execute": {
      const command = args(entry, "command", "cmd");
      const head = command === undefined ? [] : wrapSpans([{ text: `$ ${command}`, ...(theme.accent ? { color: theme.accent } : {}) }], width, nested);
      if (entry.result === undefined) return head;
      /** The runtime appends an exit-code trailer; keep it out of the collapse, since a long
       *  failing command is exactly the case where it must stay visible. */
      const trailer = EXIT_TRAILER.exec(entry.result.trimEnd());
      const body = entry.result.trimEnd().slice(0, trailer?.index).trimEnd();
      return [
        ...head,
        ...(body ? collapse(wrapFixed(body, width, style, nested), glyphs) : []),
        ...(trailer ? wrapSpans([{ text: trailer[0].trim(), ...(trailer[1] === "failed" ? theme.error ? { color: theme.error } : {} : { dimColor: true }) }], width, nested) : []),
      ];
    }
    case "read_file": return [];
    case "glob": case "grep": case "ls": {
      if (!entry.result?.trim()) return [];
      const rows = entry.result.trimEnd().split("\n");
      return collapse(rows.flatMap((row) => wrapFixed(row, width, style, nested)), glyphs, 10);
    }
    default: break;
  }
  if (entry.result === undefined) {
    const json = JSON.stringify(entry.args, null, 2);
    return json === "{}" ? [] : collapse(wrapFixed(json, width, style, nested), glyphs);
  }
  return collapse(wrapFixed(entry.result.trimEnd(), width, style, nested), glyphs);
}

/**
 * One tool call and its result rendered as a single addressable block: a header naming the
 * tool and its subject, then collapsed detail. Unknown tools fall back to truncated JSON.
 */
export function toolLines(entry: ToolEntry, width: number, theme: Theme, glyphs: Glyphs, indent = ""): StyledLine[] {
  const head: Span[] = [
    marker(entry, theme, glyphs),
    { text: entry.name, bold: true, ...(theme.toolName ? { color: theme.toolName } : {}) },
  ];
  const subject = summary(entry);
  if (subject) head.push({ text: `  ${truncate(subject.replace(/\s+/gu, " "), Math.max(8, width - entry.name.length - 6), glyphs.ellipsis)}` });
  if (entry.state === "pending") head.push({ text: `  ${glyphs.ellipsis}`, dimColor: true });
  return [...wrapSpans(head, width, indent), ...detail(entry, width, theme, glyphs, indent)];
}
