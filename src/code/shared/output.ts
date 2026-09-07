import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../config/credentials.js";

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

export function errorText(error: unknown): string {
  let text = error instanceof Error ? error.message : "Unknown coding-agent error";
  for (const key of [process.env.DCODE_API_KEY, process.env.OPENAI_API_KEY]) {
    if (key) text = text.replaceAll(key, "[redacted]");
  }
  return terminalText(redactSecrets(text))
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bsk-[\w-]+/gu, "[redacted]");
}
