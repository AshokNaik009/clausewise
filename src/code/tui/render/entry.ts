import type { Glyphs, Theme } from "../theme.js";
import type { Entry } from "../transcript.js";
import { blank, textWidth, wrapFixed, wrapSpans, type Span, type StyledLine } from "./lines.js";
import { markdownLines } from "./markdown.js";
import { toolLines } from "./tools.js";

export interface RenderOptions {
  width: number;
  theme: Theme;
  glyphs: Glyphs;
  timestamps?: boolean;
  /** Frame of the running spinner; only unsettled reasoning entries depend on it. */
  spinner?: string;
}

/** How many lines of a reasoning entry stay visible once it has settled. */
export const REASONING_PEEK = 3;

const indentFor = (namespace: string[]) => "  ".repeat(Math.min(namespace.length, 6));

function hanging(label: Span, body: Span[], width: number, indent: string): StyledLine[] {
  const pad = `${indent}${" ".repeat(textWidth(label.text))}`;
  const lines = wrapSpans(body, width, pad);
  return lines.map((line, index) => index === 0 ? { spans: [...(indent ? [{ text: indent }] : []), label, ...line.spans.slice(1)] } : line);
}

function build(entry: Entry, options: RenderOptions): StyledLine[] {
  const { width, theme, glyphs } = options;
  const stamp = options.timestamps ? `[${new Date(entry.at).toLocaleTimeString()}] ` : "";
  switch (entry.kind) {
    case "user":
      return hanging({ text: `${stamp}> `, bold: true, ...(theme.userLabel ? { color: theme.userLabel } : {}) }, [{ text: entry.text }], width, "");
    case "assistant": {
      const indent = indentFor(entry.namespace);
      const header = entry.namespace.length ? wrapSpans([{ text: `${glyphs.nested} ${entry.namespace.join("/")}`, dimColor: true }], width, indent) : [];
      const prefix = stamp ? wrapSpans([{ text: stamp, dimColor: true }], width, indent) : [];
      return [...header, ...prefix, ...markdownLines(entry.text, width, theme, glyphs, indent)];
    }
    case "reasoning": {
      const indent = indentFor(entry.namespace);
      const label: Span = entry.settled
        ? { text: `${glyphs.ok} thinking`, dimColor: true }
        : { text: `${options.spinner ?? glyphs.pending} thinking`, ...(theme.accent ? { color: theme.accent } : {}) };
      const body = entry.text.split("\n").filter((line) => line.trim());
      const visible = entry.settled ? body.slice(-REASONING_PEEK) : body.slice(-1);
      return [
        ...wrapSpans([label], width, indent),
        ...visible.flatMap((line) => wrapSpans([{ text: line, dimColor: true, italic: true }], width, `${indent}  `)),
      ];
    }
    case "tool":
      return toolLines(entry, width, theme, glyphs, indentFor(entry.namespace));
    case "notice": {
      const style = entry.level === "error" ? theme.error ? { color: theme.error } : {} : { dimColor: true };
      const label: Span = { text: `${entry.level === "error" ? glyphs.error : glyphs.bullet} `, ...style };
      /** Command output (JSON, tables, help) keeps its columns; a one-line notice reads as prose. */
      if (!entry.text.includes("\n")) return hanging(label, [{ text: entry.text, ...style }], width, "");
      const [first, ...rest] = wrapFixed(entry.text, width, style, "  ");
      return first ? [{ spans: [label, ...first.spans.slice(1)] }, ...rest] : [{ spans: [label] }];
    }
    case "status":
      return wrapSpans([{ text: `[${entry.text}]`, dimColor: true }], width);
  }
}

const cache = new WeakMap<Entry, { key: string; lines: StyledLine[] }>();

/**
 * Wrapped lines for one entry, memoised on the entry object. Entries are replaced rather than
 * mutated when they change, so a resize re-wraps only what the cache key invalidates.
 */
export function entryLines(entry: Entry, options: RenderOptions): StyledLine[] {
  const animated = entry.kind === "reasoning" && !entry.settled ? options.spinner ?? "" : "";
  const key = `${options.width}|${options.theme.name}|${options.glyphs.call}|${options.timestamps ? 1 : 0}|${animated}`;
  const hit = cache.get(entry);
  if (hit && hit.key === key) return hit.lines;
  const lines = build(entry, options);
  cache.set(entry, { key, lines });
  return lines;
}

/** The whole transcript as rendered rows, with a blank separator between entries. */
export function transcriptLines(entries: Entry[], options: RenderOptions): StyledLine[] {
  const rows: StyledLine[] = [];
  for (const [index, entry] of entries.entries()) {
    if (index) rows.push(blank());
    rows.push(...entryLines(entry, options));
  }
  return rows;
}
