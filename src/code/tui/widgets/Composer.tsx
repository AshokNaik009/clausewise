import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { COMMANDS } from "../../cli/commands.js";
import { terminalText } from "../../shared/output.js";
import { matchFiles } from "../files.js";
import { truncate } from "../render/lines.js";
import { useTheme } from "../theme.js";

interface Completion { insert: string; label: string; description?: string }

/** Rows of the completion dropdown shown under the composer. */
const VISIBLE_COMPLETIONS = 6;

export function Composer({ disabled, submit, draft, onDraft, history = [], queued = false, files = [], width = 80 }: { disabled: boolean; submit: (value: string) => boolean; draft: { text: string; revision: number }; onDraft: (text: string) => void; history?: string[]; queued?: boolean; files?: string[]; width?: number }) {
  const theme = useTheme();
  const [value, setValue] = useState(draft.text);
  const [cursor, setCursor] = useState(Array.from(draft.text).length);
  const [recall, setRecall] = useState(-1);
  const [saved, setSaved] = useState("");
  const [completion, setCompletion] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const chars = Array.from(value);

  let tokenStart = cursor;
  while (tokenStart > 0 && !/\s/u.test(chars[tokenStart - 1] ?? " ")) tokenStart--;
  const token = chars.slice(tokenStart, cursor).join("");
  const commands: Completion[] = value.startsWith("/") && !/\s/u.test(value)
    ? COMMANDS
      .filter((entry) => entry.name.startsWith(value.slice(1)) || entry.aliases.some((alias: string) => alias.startsWith(value.slice(1))))
      /** Closest match first: `/pl` should offer `/plan` before `/plugins`. */
      .slice().sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .map((entry) => ({ insert: `/${entry.name} `, label: `/${entry.name}`, description: entry.description }))
    : [];
  const fileQuery = !commands.length && token.startsWith("@") ? token.slice(1) : undefined;
  const options: Completion[] = dismissed === token ? [] : commands.length ? commands : fileQuery === undefined ? [] : matchFiles(files, fileQuery, 8).map((path) => ({ insert: `@${path} `, label: path }));
  const selected = options.length ? options[completion % options.length]! : undefined;

  const update = (text: string, position = Array.from(text).length) => { setValue(text); setCursor(position); onDraft(text); setCompletion(0); setDismissed(undefined); };
  const accept = (option: Completion) => {
    const inserted = Array.from(option.insert);
    const next = [...chars.slice(0, commands.length ? 0 : tokenStart), ...inserted, ...chars.slice(cursor)];
    update(next.join(""), (commands.length ? 0 : tokenStart) + inserted.length);
  };
  useEffect(() => { update(draft.text); setRecall(-1); }, [draft.revision]);
  useInput((input, key) => {
    if (key.ctrl && ["c", "g"].includes(input)) return;
    if (key.escape && options.length) { setDismissed(token); return; }
    if (key.tab && options.length) { setCompletion((completion + (key.shift ? options.length - 1 : 1)) % options.length); return; }
    if (key.return && !key.meta && !key.shift) {
      const exactCommand = COMMANDS.some((entry) => `/${entry.name}` === value || entry.aliases.some((alias: string) => `/${alias}` === value));
      if (selected && !exactCommand) { accept(selected); return; }
      if (value.trim() && submit(value)) { update(""); setRecall(-1); }
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (options.length) { setCompletion((completion + (key.upArrow ? options.length - 1 : 1)) % options.length); return; }
      if (!value.includes("\n") || key.ctrl) {
        if (!history.length) return;
        if (recall === -1) setSaved(value);
        const next = Math.max(-1, Math.min(history.length - 1, recall + (key.upArrow ? 1 : -1)));
        setRecall(next); update(next < 0 ? saved : history[history.length - 1 - next]!); return;
      }
      const start = chars.lastIndexOf("\n", cursor - 1) + 1;
      const column = cursor - start;
      if (key.upArrow && start > 0) { const previous = chars.lastIndexOf("\n", start - 2) + 1; setCursor(Math.min(start - 1, previous + column)); }
      if (key.downArrow) { const end = chars.indexOf("\n", cursor); if (end >= 0) { const next = chars.indexOf("\n", end + 1); setCursor(Math.min(next < 0 ? chars.length : next, end + 1 + column)); } }
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(chars.length, cursor + 1)); return; }
    if (key.ctrl && input === "a") { setCursor(chars.lastIndexOf("\n", cursor - 1) + 1); return; }
    if (key.ctrl && input === "e") { const end = chars.indexOf("\n", cursor); setCursor(end < 0 ? chars.length : end); return; }
    if (key.ctrl && input === "u") { update(""); return; }
    if (key.backspace) { chars.splice(Math.max(0, cursor - 1), cursor > 0 ? 1 : 0); update(chars.join(""), Math.max(0, cursor - 1)); return; }
    if (key.delete) { chars.splice(cursor, 1); update(chars.join(""), cursor); return; }
    if (key.pageUp || key.pageDown) return;
    const added = key.return || (key.ctrl && input === "j") ? "\n" : key.ctrl || key.meta || key.escape ? "" : terminalText(input.replace(/\r\n?/gu, "\n"));
    if (Buffer.byteLength(value) + Buffer.byteLength(added) > 100_000) return;
    chars.splice(cursor, 0, added);
    update(chars.join(""), cursor + Array.from(added).length);
  }, { isActive: !disabled });

  const hint = disabled ? "Composer paused"
    : value.startsWith("!") ? "Enter proposes this shell command through the normal approval"
    : `Enter ${queued ? "queue" : "send"} | Alt+Enter / Ctrl+J newline | @ file | ! shell | Tab cycle | Up recall | Ctrl+G editor`;
  const start = Math.min(completion - (completion % VISIBLE_COMPLETIONS), Math.max(0, options.length - VISIBLE_COMPLETIONS));
  return <Box flexDirection="column" borderStyle="round" borderColor={disabled ? "gray" : theme.accent ?? "gray"} paddingX={1} flexShrink={0}>
    <Text dimColor>{hint}</Text>
    <Box height={Math.min(4, Math.max(1, value.split("\n").length))} overflow="hidden"><Text wrap="wrap">{chars.slice(Math.max(0, cursor - 500), cursor).join("")}<Text inverse>{disabled ? " " : chars[cursor] ?? " "}</Text>{chars.slice(cursor + 1, cursor + 300).join("")}</Text></Box>
    {options.slice(start, start + VISIBLE_COMPLETIONS).map((option, index) => {
      const active = options[start + index] === selected;
      return <Text key={option.label} wrap="truncate">
        <Text {...(active ? { bold: true, ...(theme.accent ? { color: theme.accent } : { inverse: true }) } : {})}>{active ? "> " : "  "}{option.label}</Text>
        {option.description ? <Text dimColor>  {truncate(option.description, Math.max(10, width - option.label.length - 8))}</Text> : null}
      </Text>;
    })}
    {options.length > VISIBLE_COMPLETIONS ? <Text dimColor>  {completion % options.length + 1}/{options.length}</Text> : null}
  </Box>;
}
