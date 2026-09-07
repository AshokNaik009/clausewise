import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { terminalText } from "../../shared/output.js";

export function SecretField({ label, submit }: { label: string; submit: (secret: string | undefined) => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) submit(undefined);
    else if (key.return) { if (value.trim()) submit(value.trim()); }
    else if (key.backspace || key.delete) setValue(value.slice(0, -1));
    else if (!key.ctrl && !key.meta) setValue((value + terminalText(input).replace(/\s/gu, "")).slice(0, 16_384));
  });
  return <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}><Text>{terminalText(label)}</Text><Text>{"*".repeat(Math.min(value.length, 40))}</Text><Text dimColor>Stored privately for this endpoint. Enter save | Esc cancel</Text></Box>;
}
