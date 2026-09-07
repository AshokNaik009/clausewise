import { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { wrapTerminal } from "../layout.js";
import { terminalText } from "../../shared/output.js";

export function ConfirmationPanel({ title, text, choose }: { title: string; text: string; choose: (accepted: boolean) => void }) {
  const { stdout } = useStdout();
  const [offset, setOffset] = useState(0);
  const count = Math.max(2, (stdout.rows || 24) - 15);
  const lines = useMemo(() => wrapTerminal(terminalText(text), Math.max(10, (stdout.columns || 80) - 10)), [text, stdout.columns]);
  useInput((input, key) => {
    if (input === "y") choose(true);
    else if (input === "n" || key.escape || (key.ctrl && input === "c")) choose(false);
    else if (key.downArrow || key.pageDown) setOffset((value) => Math.min(Math.max(0, lines.length - count), value + (key.pageDown ? count : 1)));
    else if (key.upArrow || key.pageUp) setOffset((value) => Math.max(0, value - (key.pageUp ? count : 1)));
  });
  return <Box flexDirection="column"><Text bold color="yellow">{terminalText(title)}</Text>{lines.slice(offset, offset + count).map((line, index) => <Text key={index}>{line}</Text>)}<Text dimColor>Lines {offset + 1}-{Math.min(lines.length, offset + count)}/{lines.length} | PgUp/PgDn</Text><Text>y accept | n / Esc cancel</Text></Box>;
}
