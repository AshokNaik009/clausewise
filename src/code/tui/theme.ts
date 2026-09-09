import { createContext, useContext } from "react";

/**
 * Semantic colour tokens. Values are Ink colour names, or `undefined` to inherit the
 * terminal's own foreground so the `plain` theme stays genuinely colourless.
 */
export interface Theme {
  name: "dark" | "light" | "plain";
  text?: string;
  dim?: string;
  accent?: string;
  success?: string;
  error?: string;
  warning?: string;
  mdHeading?: string;
  mdCode?: string;
  toolName?: string;
  toolOutput?: string;
  userLabel?: string;
  diffAdd?: string;
  diffRemove?: string;
  border?: string;
}

export const THEMES: Record<Theme["name"], Theme> = {
  dark: { name: "dark", dim: "gray", accent: "cyan", success: "green", error: "red", warning: "yellow", mdHeading: "cyan", mdCode: "magenta", toolName: "cyan", toolOutput: "gray", userLabel: "green", diffAdd: "green", diffRemove: "red", border: "gray" },
  light: { name: "light", dim: "gray", accent: "blue", success: "green", error: "red", warning: "yellow", mdHeading: "blue", mdCode: "magenta", toolName: "blue", toolOutput: "gray", userLabel: "green", diffAdd: "green", diffRemove: "red", border: "gray" },
  plain: { name: "plain" },
};

export function themeFor(name: string | undefined): Theme {
  return THEMES[name === "light" || name === "plain" ? name : "dark"];
}

export const ThemeContext = createContext<Theme>(THEMES.dark);
export function useTheme(): Theme { return useContext(ThemeContext); }

/** Glyphs used by the transcript renderers, with an ASCII fallback for terminals that cannot show them. */
export interface Glyphs {
  call: string;
  pending: string;
  ok: string;
  error: string;
  nested: string;
  bullet: string;
  quote: string;
  ellipsis: string;
  /** Footer separator and spinner frames; the unicode set keeps the two visually distinct. */
  separator: string;
  spinner: string[];
}
const UNICODE: Glyphs = { call: "⏺", pending: "◐", ok: "✓", error: "✗", nested: "▶", bullet: "•", quote: "│", ellipsis: "…", separator: " · ", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] };
const ASCII: Glyphs = { call: "*", pending: ".", ok: "+", error: "!", nested: ">", bullet: "-", quote: "|", ellipsis: "...", separator: " | ", spinner: ["-", "\\", "|", "/"] };

/** `auto` uses ASCII unless the locale advertises UTF-8, since a wrong guess corrupts every line. */
export function resolveCharset(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): "unicode" | "ascii" {
  if (setting === "unicode" || setting === "ascii") return setting;
  if (env.TERM === "dumb") return "ascii";
  return /utf-?8/iu.test(`${env.LC_ALL ?? ""} ${env.LC_CTYPE ?? ""} ${env.LANG ?? ""}`) ? "unicode" : "ascii";
}

export function glyphs(charset: "unicode" | "ascii"): Glyphs { return charset === "ascii" ? ASCII : UNICODE; }

export const GlyphContext = createContext<Glyphs>(UNICODE);
export function useGlyphs(): Glyphs { return useContext(GlyphContext); }
