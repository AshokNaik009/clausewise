import { randomUUID } from "node:crypto";

export interface QueuedPrompt { id: string; sessionId: string; text: string }
export class PromptQueue {
  private entries: QueuedPrompt[] = [];
  paused = false;
  get size(): number { return this.entries.length; }
  snapshot(): QueuedPrompt[] { return this.entries.map((entry) => ({ ...entry })); }
  push(sessionId: string, text: string): void {
    if (!text.trim()) throw new Error("Queued input must not be empty");
    if (this.entries.length >= 50 || this.entries.reduce((total, entry) => total + Buffer.byteLength(entry.text), Buffer.byteLength(text)) > 1_000_000) throw new Error("Prompt queue limit reached (50 entries / 1 MB)");
    this.entries.push({ id: randomUUID(), sessionId, text });
  }
  take(sessionId: string): QueuedPrompt | undefined {
    if (this.paused || !this.entries.length) return;
    if (this.entries[0]!.sessionId !== sessionId) { this.paused = true; throw new Error("Queue belongs to another session; switch back or clear it before continuing"); }
    return this.entries.shift();
  }
  remove(index: number): QueuedPrompt {
    if (!Number.isInteger(index) || index < 1 || index > this.entries.length) throw new Error("Choose a valid queue entry number");
    return this.entries.splice(index - 1, 1)[0]!;
  }
  clear(): void { this.entries = []; this.paused = false; }
}
