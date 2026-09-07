import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { YOLO_ACKNOWLEDGEMENT } from "../../protocol/session-controls.js";
import { terminalText } from "../../shared/output.js";

export function ModeConfirmation({ confirm }: { confirm: (acknowledgement: string | undefined) => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) confirm(undefined);
    else if (key.return) { if (value === YOLO_ACKNOWLEDGEMENT) confirm(value); }
    else if (key.backspace || key.delete) setValue(value.slice(0, -1));
    else if (!key.ctrl && !key.meta) setValue((value + terminalText(input)).slice(0, 100));
  });
  return <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={1}>
    <Text bold color="red">YOLO: unrestricted host actions</Text>
    <Text>The agent can execute commands, change files, delegate work, and invoke connected tools without individual approval. This is not a sandbox.</Text>
    <Text>Type exactly: {YOLO_ACKNOWLEDGEMENT}</Text>
    <Text inverse>{value || " "}</Text>
    <Text dimColor>Enter confirm | Esc cancel. The mode resets on restart or runtime changes.</Text>
  </Box>;
}
