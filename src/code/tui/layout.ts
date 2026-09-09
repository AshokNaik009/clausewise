const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cellWidth(grapheme: string): number {
  if (/^[\p{Mark}\p{Default_Ignorable_Code_Point}]+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
}

export function wrapTerminal(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const source of text.split("\n")) {
    let line = "";
    let cells = 0;
    for (const { segment } of segmenter.segment(source.replace(/\t/gu, "    "))) {
      const size = cellWidth(segment);
      if (cells + size > width && line) { lines.push(line); line = ""; cells = 0; }
      line += segment;
      cells += size;
    }
    lines.push(line);
  }
  return lines;
}
