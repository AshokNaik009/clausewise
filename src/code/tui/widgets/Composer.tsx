import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { COMMANDS } from "../../cli/commands.js";
import { terminalText } from "../../shared/output.js";

export function Composer({ disabled, submit }: { disabled: boolean; submit: (value: string) => void }) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const chars = Array.from(value);
  const matches = value.startsWith("/") && !value.includes(" ") ? COMMANDS.filter((entry) => entry.name.startsWith(value.slice(1))) : [];
  useInput((input, key) => {
    if (key.ctrl && input === "c") return;
    if (key.tab && matches[0]) { const next = `/${matches[0].name} `; setValue(next); setCursor(next.length); return; }
    if (key.return && !key.meta && !key.shift) {
      if (value.trim()) { submit(value); setValue(""); setCursor(0); }
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(chars.length, cursor + 1)); return; }
    if (key.ctrl && input === "a") { setCursor(0); return; }
    if (key.ctrl && input === "e") { setCursor(chars.length); return; }
    if (key.ctrl && input === "u") { setValue(""); setCursor(0); return; }
    if (key.backspace || key.delete) { chars.splice(Math.max(0, cursor - 1), cursor > 0 ? 1 : 0); setValue(chars.join("")); setCursor(Math.max(0, cursor - 1)); return; }
    const added = key.return || (key.ctrl && input === "j") ? "\n" : key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow ? "" : terminalText(input.replace(/\r\n?/gu, "\n"));
    if (value.length + added.length > 100_000) return;
    chars.splice(cursor, 0, added);
    setValue(chars.join(""));
    setCursor(cursor + Array.from(added).length);
  }, { isActive: !disabled });
  return <Box flexDirection="column" borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
    <Text dimColor>{disabled ? "Composer paused" : "Enter send | Alt+Enter / Ctrl+J newline | Tab complete | Ctrl+U clear"}</Text>
    <Text wrap="wrap">{chars.slice(Math.max(0, cursor - 1200), cursor).join("")}<Text inverse>{disabled ? " " : chars[cursor] ?? " "}</Text>{chars.slice(cursor + 1, cursor + 600).join("")}</Text>
    {matches.length > 0 && <Text dimColor>{matches.slice(0, 5).map((entry) => `/${entry.name}`).join("  ")}</Text>}
  </Box>;
}
