import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { terminalText } from "../../shared/output.js";

export interface PickerItem { value: string; label: string }
export function Picker({ title, items, choose }: { title: string; items: PickerItem[]; choose: (value: string | undefined) => void }) {
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const visible = items.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) { choose(undefined); return; }
    if (key.upArrow) { setIndex(Math.max(0, index - 1)); return; }
    if (key.downArrow) { setIndex(Math.min(visible.length - 1, index + 1)); return; }
    if (key.return) { if (visible[index]) choose(visible[index].value); return; }
    if (key.backspace || key.delete) setFilter(filter.slice(0, -1));
    else if (!key.ctrl && !key.meta) setFilter(filter + terminalText(input));
    setIndex(0);
  });
  return <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
    <Text bold>{title}</Text><Text>Filter: {filter}</Text>
    {visible.slice(Math.max(0, index - 5), Math.max(0, index - 5) + 10).map((item) => <Text key={item.value} inverse={item === visible[index]}>{terminalText(item.label)}</Text>)}
    <Text dimColor>Up/Down select | Enter confirm | Esc close</Text>
  </Box>;
}
