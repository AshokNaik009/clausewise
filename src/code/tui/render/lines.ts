import { cellWidth, wrapTerminal } from "../layout.js";

/** A styled run of text. The fields are Ink `<Text>` props, so a span renders directly. */
export interface Span {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}
export type Style = Omit<Span, "text">;
/** One rendered terminal row. Already wrapped: the renderer never re-measures it. */
export interface StyledLine { spans: Span[] }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function textWidth(text: string): number {
  let cells = 0;
  for (const { segment } of segmenter.segment(text)) cells += cellWidth(segment);
  return cells;
}

export const blank = (): StyledLine => ({ spans: [] });
export const lineText = (line: StyledLine): string => line.spans.map((span) => span.text).join("");

/** Splits a single unbreakable run into chunks no wider than `limit` cells. */
function chunks(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  let cells = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = cellWidth(segment);
    if (cells + size > limit && current) { pieces.push(current); current = ""; cells = 0; }
    current += segment;
    cells += size;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Word-aware wrap that keeps each span's style. Over-long runs (paths, URLs, base64) are
 * hard-split rather than allowed to overflow the viewport.
 */
export function wrapSpans(spans: Span[], width: number, indent = ""): StyledLine[] {
  const usable = Math.max(1, width - textWidth(indent));
  const lines: StyledLine[] = [];
  let current: Span[] = [];
  let cells = 0;
  let lastStyle: Style | undefined;
  const flush = () => {
    lines.push({ spans: indent ? [{ text: indent }, ...current] : current });
    current = [];
    cells = 0;
    lastStyle = undefined;
  };
  const add = (text: string, style: Style) => {
    const last = current.at(-1);
    if (last && style === lastStyle) last.text += text;
    else { current.push({ text, ...style }); lastStyle = style; }
    cells += textWidth(text);
  };
  for (const { text, ...style } of spans) {
    for (const token of text.split(/(\s+)/u)) {
      if (!token) continue;
      const size = textWidth(token);
      if (/^\s+$/u.test(token)) {
        if (cells === 0) continue;
        if (cells + size > usable) { flush(); continue; }
        add(token, style);
        continue;
      }
      if (size <= usable) {
        if (cells + size > usable) flush();
        add(token, style);
        continue;
      }
      for (const chunk of chunks(token, usable)) {
        if (cells > 0 && cells + textWidth(chunk) > usable) flush();
        add(chunk, style);
      }
    }
  }
  if (current.length || !lines.length) flush();
  return lines;
}

/** Hard wrap for content whose columns matter: diffs, command output, JSON. */
export function wrapFixed(text: string, width: number, style: Style = {}, indent = ""): StyledLine[] {
  const usable = Math.max(1, width - textWidth(indent));
  return wrapTerminal(text, usable).map((line) => ({ spans: indent ? [{ text: indent }, { text: line, ...style }] : [{ text: line, ...style }] }));
}

/** Trailing-truncation with an ellipsis, for one-line summaries that must not wrap. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (textWidth(text) <= width) return text;
  const limit = Math.max(0, width - textWidth(ellipsis));
  return `${chunks(text, limit)[0] ?? ""}${ellipsis}`;
}

/** Hard wrap that keeps per-token styling: for highlighted code, where columns matter. */
export function wrapSpansFixed(spans: Span[], width: number, indent = ""): StyledLine[] {
  const usable = Math.max(1, width - textWidth(indent));
  const lines: StyledLine[] = [];
  let current: Span[] = [];
  let cells = 0;
  const flush = () => { lines.push({ spans: indent ? [{ text: indent }, ...current] : current }); current = []; cells = 0; };
  for (const { text, ...style } of spans) {
    let remaining = text;
    while (remaining) {
      if (cells >= usable) { flush(); continue; }
      const piece = chunks(remaining, usable - cells)[0] ?? "";
      if (!piece) break;
      current.push({ text: piece, ...style });
      cells += textWidth(piece);
      remaining = remaining.slice(piece.length);
      if (remaining) flush();
    }
  }
  if (current.length || !lines.length) flush();
  return lines;
}
