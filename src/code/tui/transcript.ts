import type { CodeEvent } from "../protocol/index.js";
import { terminalText } from "../shared/output.js";

/**
 * The transcript is a list of addressable entries rather than one appended string, so a
 * renderer can style each one on its own and a resize only re-wraps what changed.
 */
export type Entry =
  | { kind: "user"; text: string; at: number }
  | { kind: "assistant"; text: string; at: number; namespace: string[] }
  | { kind: "reasoning"; text: string; at: number; namespace: string[]; settled: boolean }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; result?: string; state: "pending" | "ok" | "error"; namespace: string[]; at: number }
  | { kind: "notice"; text: string; level: "info" | "error"; at: number }
  | { kind: "status"; text: string; at: number };

/** Entries, not characters: the old 300 KB character cap truncated mid-diff. */
export const MAX_ENTRIES = 2000;

function capped(entries: Entry[]): Entry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
}

export function appendEntry(entries: Entry[], entry: Entry): Entry[] {
  return capped([...entries, entry]);
}

const sameNamespace = (a: string[], b: string[]) => a.length === b.length && a.every((part, index) => part === b[index]);

/**
 * Folds one runtime event into the entry list. Consecutive assistant text coalesces into the
 * trailing entry, and a `tool_result` merges into the `tool_call` that shares its id instead
 * of emitting a second line.
 */
export function appendEvent(entries: Entry[], event: CodeEvent, at: number = Date.now()): Entry[] {
  const last = entries.at(-1);
  switch (event.type) {
    case "text": {
      const text = terminalText(event.text);
      if (last?.kind === "reasoning" && sameNamespace(last.namespace, event.namespace) && !last.settled) {
        return appendEvent([...entries.slice(0, -1), { ...last, settled: true }], event, at);
      }
      if (last?.kind === "assistant" && sameNamespace(last.namespace, event.namespace)) {
        return [...entries.slice(0, -1), { ...last, text: last.text + text }];
      }
      return appendEntry(entries, { kind: "assistant", text, at, namespace: event.namespace });
    }
    case "reasoning": {
      const text = terminalText(event.text);
      if (last?.kind === "reasoning" && sameNamespace(last.namespace, event.namespace) && !last.settled) {
        return [...entries.slice(0, -1), { ...last, text: last.text + text }];
      }
      return appendEntry(entries, { kind: "reasoning", text, at, namespace: event.namespace, settled: false });
    }
    case "tool_call":
      return appendEntry(entries, { kind: "tool", id: event.id, name: event.name, args: event.args, state: "pending", namespace: event.namespace, at });
    case "tool_result": {
      const result = terminalText(event.content);
      const state = event.status === "error" ? "error" : "ok";
      let index = -1;
      if (event.id) for (let position = entries.length - 1; position >= 0; position--) {
        const entry = entries[position]!;
        if (entry.kind === "tool" && entry.id === event.id && entry.state === "pending") { index = position; break; }
      }
      if (index < 0) return appendEntry(entries, { kind: "tool", id: event.id, name: event.name, args: {}, result, state, namespace: event.namespace, at });
      const merged: Entry = { ...(entries[index] as Extract<Entry, { kind: "tool" }>), result, state };
      return [...entries.slice(0, index), merged, ...entries.slice(index + 1)];
    }
    case "notice":
      return appendEntry(entries, { kind: "notice", text: terminalText(event.message), level: "info", at });
    case "policy":
      return appendEntry(entries, { kind: "notice", text: terminalText(`[${event.mode}] ${event.message}`), level: "info", at });
    default:
      return entries;
  }
}

/** Flat projection of the transcript, for tests and for any consumer that needs plain text. */
export function toPlainText(entries: Entry[]): string {
  return entries.map((entry) => {
    switch (entry.kind) {
      case "user": return `You: ${entry.text}`;
      case "assistant": return entry.namespace.length ? `[${entry.namespace.join("/")}] ${entry.text}` : entry.text;
      case "reasoning": return `[thinking] ${entry.text}`;
      case "tool": return `[${entry.name}] ${JSON.stringify(entry.args)}${entry.result === undefined ? "" : `\n${entry.result}`}`;
      case "notice": return `[notice] ${entry.text}`;
      case "status": return `[${entry.text}]`;
    }
  }).join("\n\n");
}
