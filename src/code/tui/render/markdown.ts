import type { Glyphs, Theme } from "../theme.js";
import { blank, wrapSpans, wrapSpansFixed, type Span, type Style, type StyledLine } from "./lines.js";

/**
 * A small hand-rolled markdown renderer. It deliberately matches how the rest of the port
 * hand-rolls diffing, grapheme wrapping, and cell width rather than adding a runtime
 * dependency; the trade-off is limited language coverage in fenced blocks and no nested
 * emphasis.
 */

const INLINE = /(`+)([^`]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|(?<![\w_])_([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/gu;

/** Splits one line of markdown into styled spans. Emphasis does not nest. */
function inlineSpans(text: string, theme: Theme, base: Style = {}): Span[] {
  const spans: Span[] = [];
  const push = (value: string, style: Style) => { if (value) spans.push({ text: value, ...style }); };
  let index = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
    push(text.slice(index, match.index), base);
    const [, , code, bold, boldAlt, strike, italic, italicAlt, label, url, link] = match;
    if (code !== undefined) push(code, { ...base, ...(theme.mdCode ? { color: theme.mdCode } : {}) });
    else if (bold !== undefined || boldAlt !== undefined) push((bold ?? boldAlt)!, { ...base, bold: true });
    else if (strike !== undefined) push(strike, { ...base, strikethrough: true });
    else if (italic !== undefined || italicAlt !== undefined) push((italic ?? italicAlt)!, { ...base, italic: true });
    else if (label !== undefined) {
      push(label, { ...base, underline: true, ...(theme.accent ? { color: theme.accent } : {}) });
      push(` (${url})`, { ...base, dimColor: true });
    } else if (link !== undefined) push(link, { ...base, underline: true, ...(theme.accent ? { color: theme.accent } : {}) });
    index = match.index + match[0].length;
  }
  push(text.slice(index), base);
  return spans.length ? spans : [{ text: "", ...base }];
}

const KEYWORDS: Record<string, string[]> = {
  js: ["async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "interface", "let", "new", "of", "return", "static", "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "yield", "true", "false", "null", "undefined"],
  py: ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "none", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "True", "False", "None"],
  sh: ["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local", "return", "then", "until", "while"],
};

function family(language: string): { keywords: string[]; comment: RegExp } | undefined {
  const name = language.toLowerCase();
  if (["js", "jsx", "javascript", "ts", "tsx", "typescript", "json", "jsonc"].includes(name)) return { keywords: KEYWORDS.js!, comment: /\/\/.*$/u };
  if (["py", "python"].includes(name)) return { keywords: KEYWORDS.py!, comment: /#.*$/u };
  if (["sh", "bash", "zsh", "shell", "console", "toml", "yaml", "yml", "ini"].includes(name)) return { keywords: KEYWORDS.sh!, comment: /#.*$/u };
  return undefined;
}

/** Keyword/string/number/comment highlighting only. Unknown languages render unstyled. */
function highlightCode(line: string, language: string, theme: Theme): Span[] {
  const rules = family(language);
  const base: Style = {};
  if (!rules || !line.trim()) return [{ text: line, ...base }];
  const pattern = new RegExp(`(${rules.comment.source})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d[\\w.]*)\\b|\\b(${rules.keywords.join("|")})\\b`, "gu");
  const spans: Span[] = [];
  let index = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index > index) spans.push({ text: line.slice(index, match.index), ...base });
    const [, comment, string, number, keyword] = match;
    if (comment !== undefined) spans.push({ text: comment, dimColor: true });
    else if (string !== undefined) spans.push({ text: string, ...(theme.success ? { color: theme.success } : {}) });
    else if (number !== undefined) spans.push({ text: number, ...(theme.warning ? { color: theme.warning } : {}) });
    else if (keyword !== undefined) spans.push({ text: keyword, ...(theme.mdCode ? { color: theme.mdCode } : { bold: true }) });
    index = match.index + match[0].length;
  }
  if (index < line.length) spans.push({ text: line.slice(index), ...base });
  return spans.length ? spans : [{ text: line, ...base }];
}

const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+#-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u;

/** Renders a markdown document to wrapped, styled terminal rows. */
export function markdownLines(text: string, width: number, theme: Theme, glyphs: Glyphs, indent = ""): StyledLine[] {
  const out: StyledLine[] = [];
  const rows = text.split("\n");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const fence = FENCE.exec(row);
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      index++;
      while (index < rows.length && !FENCE.test(rows[index]!)) body.push(rows[index++]!);
      const rail = `${glyphs.quote} `;
      if (language) out.push(...wrapSpans([{ text: language, dimColor: true }], width, indent));
      for (const code of body) out.push(...wrapSpansFixed(highlightCode(code, language, theme), width, `${indent}${rail}`));
      continue;
    }
    const heading = HEADING.exec(row);
    if (heading) {
      out.push(...wrapSpans(inlineSpans(heading[2]!, theme, { bold: true, ...(theme.mdHeading ? { color: theme.mdHeading } : {}) }), width, indent));
      continue;
    }
    if (RULE.test(row)) {
      out.push({ spans: [{ text: `${indent}${(glyphs.quote === "|" ? "-" : "─").repeat(Math.max(1, width - indent.length))}`, dimColor: true }] });
      continue;
    }
    const quote = QUOTE.exec(row);
    if (quote) {
      out.push(...wrapSpans([{ text: `${glyphs.quote} `, dimColor: true }, ...inlineSpans(quote[1]!, theme, { dimColor: true })], width, indent));
      continue;
    }
    const list = LIST.exec(row);
    if (list) {
      const marker = /^\d/u.test(list[2]!) ? list[2]! : glyphs.bullet;
      const lead = `${indent}${list[1]}${marker} `;
      const wrapped = wrapSpans(inlineSpans(list[3]!, theme), width, " ".repeat(lead.length));
      out.push(...wrapped.map((line, position) => position === 0 ? { spans: [{ text: lead, ...(theme.accent ? { color: theme.accent } : {}) }, ...line.spans.slice(1)] } : line));
      continue;
    }
    if (!row.trim()) { out.push(blank()); continue; }
    out.push(...wrapSpans(inlineSpans(row, theme), width, indent));
  }
  return out;
}
