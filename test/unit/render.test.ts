import { describe, expect, it } from "vitest";
import { renderForTerminal } from "../../src/shell.js";

const strip = (value: string): string => value.replace(/\[\d+m/gu, "");

describe("terminal rendering", () => {
  it("wraps long prose to the terminal width", () => {
    const long = `A ${"word ".repeat(60)}end.`;
    for (const line of renderForTerminal(long, 60).split("\n")) {
      expect(strip(line).length).toBeLessThanOrEqual(60);
    }
  });

  it("renders headings, bullets and numbered items without markdown syntax", () => {
    const out = renderForTerminal("## Summary\n\n- first **item**\n- second `code`\n\n1. step one\n2. step two", 80);
    const plain = strip(out);
    expect(plain).toContain("Summary");
    expect(plain).not.toContain("##");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("`");
    expect(plain).toContain("• first item");
    expect(plain).toContain("1. step one");
  });

  it("indents continuation lines of a wrapped bullet", () => {
    const lines = renderForTerminal(`- ${"alpha ".repeat(30)}`, 50).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(strip(lines[0]!).startsWith("• ")).toBe(true);
    expect(strip(lines[1]!).startsWith("  ")).toBe(true);
  });

  it("keeps code fences as plain indented text", () => {
    const plain = strip(renderForTerminal("Try:\n```bash\nnpm start\n```", 80));
    expect(plain).toContain("npm start");
    expect(plain).not.toContain("```");
  });
});
