import { Box, Text } from "ink";
import type { ApprovalMode } from "../../protocol/session-controls.js";
import { PORT_VERSION } from "../../shared/parity.js";
import { terminalText } from "../../shared/output.js";
import { useTheme } from "../theme.js";
import { truncate } from "../render/lines.js";

const CHIPS: Record<ApprovalMode, { label: string; token: "warning" | "accent" | "error" }> = {
  manual: { label: "MANUAL", token: "warning" },
  plan: { label: "PLAN", token: "accent" },
  auto: { label: "AUTO", token: "warning" },
  yolo: { label: "YOLO", token: "error" },
};

export function Header({ mode, title, sessionId, width }: { mode: ApprovalMode; title: string; sessionId: string; width: number }) {
  const theme = useTheme();
  const chip = CHIPS[mode] ?? CHIPS.manual;
  return <Box flexDirection="column" flexShrink={0}>
    <Box justifyContent="space-between">
      <Text bold {...(theme.accent ? { color: theme.accent } : {})}>dcode-ts {PORT_VERSION}</Text>
      <Text bold {...(theme[chip.token] ? { color: theme[chip.token] } : {})}>{chip.label} | HOST EXECUTION</Text>
    </Box>
    <Text dimColor wrap="truncate">{truncate(terminalText(title), Math.max(8, width - sessionId.length - 3))} | {sessionId}</Text>
  </Box>;
}
