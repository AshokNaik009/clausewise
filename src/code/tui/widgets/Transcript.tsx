import { Text } from "ink";
import type { StyledLine } from "../render/lines.js";

/** Renders one pre-wrapped row. Spans carry their own Ink props, so nothing is re-measured. */
function Row({ line }: { line: StyledLine }) {
  if (!line.spans.length) return <Text> </Text>;
  return <Text wrap="truncate">{line.spans.map(({ text, ...style }, index) => <Text key={index} {...style}>{text}</Text>)}</Text>;
}

export function Transcript({ lines, from, to }: { lines: StyledLine[]; from: number; to: number }) {
  return <>{lines.slice(from, to).map((line, index) => <Row key={from + index} line={line} />)}</>;
}
