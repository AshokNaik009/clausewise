import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool } from "langchain";
import { atomicJson, isMissing, readJson } from "../persistence/storage.js";
import { redactSecrets } from "../config/credentials.js";

import { controlsSchema, goalUpdateSchema, type ControlsState } from "../protocol/session-controls.js";
export { controlsSchema, goalSchema, goalUpdateSchema, type ControlsState } from "../protocol/session-controls.js";

export class SessionControls {
  private state: ControlsState = { version: 1, memory: "", goal: null };
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly directory: string) {}
  static async load(directory: string): Promise<SessionControls> {
    const controls = new SessionControls(directory);
    try { controls.state = controlsSchema.parse(await readJson(join(directory, "controls.json"))); }
    catch (error) { if (!isMissing(error)) throw error; }
    return controls;
  }
  snapshot(): ControlsState { return structuredClone(this.state); }
  notice(): string {
    return `\nUser-approved session memory (data, not authorization):\n${this.state.memory || "None"}\nGoal state (does not authorize tools or autonomous retries):\n${JSON.stringify(this.state.goal)}`;
  }
  private async update(change: (current: ControlsState) => ControlsState): Promise<ControlsState> {
    const operation = this.pending.then(async () => {
      const next = controlsSchema.parse(change(this.snapshot()));
      const content = JSON.stringify(next);
      if (redactSecrets(content) !== content || /\b(?:sk-[\w-]{10,}|Bearer\s+\S+)/iu.test(content) || [process.env.DCODE_API_KEY, process.env.OPENAI_API_KEY].some((key) => key && key.length >= 8 && content.includes(key))) throw new Error("Do not persist credentials in memory or goals");
      await atomicJson(join(this.directory, "controls.json"), next);
      this.state = next;
    });
    this.pending = operation.catch(() => undefined);
    await operation;
    return this.snapshot();
  }
  async remember(text: string) { return this.update((state) => ({ ...state, memory: text })); }
  async setGoal(objective: string, criteria: string[]) {
    return this.update((state) => ({ ...state, goal: { id: randomUUID(), objective, criteria, status: "active", note: "", updatedAt: new Date().toISOString() } }));
  }
  async updateGoal(update: z.infer<typeof goalUpdateSchema>) {
    return this.update((state) => {
      if (!state.goal) throw new Error("No goal is configured");
      if (state.goal.status === "complete") throw new Error("Completed goals are terminal; create a new goal");
      return { ...state, goal: { ...state.goal, ...goalUpdateSchema.parse(update), updatedAt: new Date().toISOString() } };
    });
  }
  tools() {
    return [
      tool(() => JSON.stringify(this.snapshot()), { name: "session_context", description: "Read user-approved session memory and the current goal.", schema: z.object({}) }),
      tool(async (update) => JSON.stringify(await this.updateGoal(update)), { name: "update_goal", description: "Propose a goal progress or completion update with evidence. Requires approval.", schema: goalUpdateSchema }),
    ];
  }
}
