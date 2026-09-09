import { Box, Text } from "ink";
import { terminalText } from "../../shared/output.js";
import { textWidth, truncate } from "../render/lines.js";
import { useGlyphs, useTheme, type Theme } from "../theme.js";

export interface Segment {
  text: string;
  /** Semantic colour token, resolved against the active theme. */
  token?: keyof Theme;
  /** Higher survives longer as the terminal narrows. */
  priority: number;
}

/** Drops the lowest-priority segments until the bar fits, Starship-style. */
export function fitSegments(segments: Segment[], width: number, separator = " | "): Segment[] {
  const kept = [...segments];
  const measure = () => kept.reduce((total, segment) => total + textWidth(segment.text), 0) + Math.max(0, kept.length - 1) * textWidth(separator);
  while (kept.length > 1 && measure() > width) {
    let weakest = 0;
    for (let index = 1; index < kept.length; index++) if (kept[index]!.priority < kept[weakest]!.priority) weakest = index;
    kept.splice(weakest, 1);
  }
  return kept;
}

export function StatusBar({ segments, width }: { segments: Segment[]; width: number }) {
  const theme = useTheme();
  const glyphs = useGlyphs();
  const visible = fitSegments(segments.filter((segment) => segment.text), width, glyphs.separator);
  return <Box flexShrink={0}>
    {visible.map((segment, index) => {
      const colour = segment.token ? theme[segment.token] : undefined;
      return <Text key={index} wrap="truncate">
        {index ? <Text dimColor>{glyphs.separator}</Text> : null}
        <Text {...(typeof colour === "string" ? { color: colour } : { dimColor: true })}>{terminalText(segment.text)}</Text>
      </Text>;
    })}
  </Box>;
}

/** The footer's segment set: mode, activity, queue, model, branch, tokens, cost, cwd. */
export function statusSegments(input: {
  mode: string;
  activity: string;
  connection: string;
  queued: number;
  paused: boolean;
  model: string;
  branch?: string;
  tokens: number;
  costUsd?: number;
  cwd?: string;
  width: number;
}, glyphs: { bullet: string }): Segment[] {
  return [
    { text: input.mode.toUpperCase(), token: "accent", priority: 100 },
    { text: input.activity, priority: 95 },
    { text: input.connection, priority: 40 },
    { text: input.queued || input.paused ? `queued ${input.queued}${input.paused ? " paused" : ""}` : "", token: "warning", priority: 90 },
    { text: input.model, priority: 70 },
    { text: input.branch ? `${glyphs.bullet} ${input.branch}` : "", token: "success", priority: 60 },
    { text: `${input.tokens} tok`, priority: 50 },
    { text: input.costUsd === undefined ? "" : `$${input.costUsd.toFixed(4)}`, priority: 30 },
    { text: input.cwd ? truncate(input.cwd, Math.max(8, Math.floor(input.width / 3))) : "", priority: 10 },
  ];
}

/** Keyboard hints; separate from the status segments so they are dropped first. */
export function HintBar({ busy, scroll, position }: { busy: boolean; scroll: boolean; position?: string }) {
  const glyphs = useGlyphs();
  return <Text dimColor wrap="truncate">
    PgUp/PgDn scroll {glyphs.bullet} Ctrl+C {busy ? "cancel" : "exit"} {glyphs.bullet} /continue approvals{position ? ` ${glyphs.bullet} ${position}` : ""}{scroll ? ` ${glyphs.bullet} SCROLLBACK` : ""}
  </Text>;
}
