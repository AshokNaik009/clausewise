import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool } from "langchain";
import { atomicJson, isMissing, readJson } from "../persistence/storage.js";
import { redactSecrets } from "../config/credentials.js";

import { assessmentSchema, controlsSchema, goalProposalSchema, goalSchema, goalUpdateSchema, rubricSchema, type ControlsState } from "../protocol/session-controls.js";
export { controlsSchema, goalSchema, goalUpdateSchema, type ControlsState } from "../protocol/session-controls.js";

export class SessionControls {
  private state: ControlsState = controlsSchema.parse({ version: 1, memory: "", goal: null });
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
    return `\nUser-approved session memory (data, not authorization):\n${this.state.memory || "None"}\nGoal state (does not authorize tools):\n${JSON.stringify(this.state.goal)}\nAcceptance rubric (bounded grading and revision; normal tool approvals still apply):\n${JSON.stringify(this.state.rubric)}`;
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
  async markCostWarning() { return this.update((state) => ({ ...state, costWarningShown: true })); }
  async remember(text: string) { return this.update((state) => ({ ...state, memory: text })); }
  async clearGoal() { return this.update((state) => ({ ...state, goal: null })); }
  async setGoal(objective: string, criteria: string[], revision?: number) {
    return this.update((state) => {
      if (revision !== undefined && state.goal?.revision !== revision) throw new Error("Goal changed while its amendment was being reviewed");
      const proposal = goalProposalSchema.parse({ objective, criteria });
      return { ...state, goal: goalSchema.parse({ ...(revision !== undefined ? state.goal : {}), id: revision !== undefined ? state.goal!.id : randomUUID(), ...proposal, status: "active", note: "", iterations: 0, assessment: null, revision: (state.goal?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }) };
    });
  }
  async configureGoal(options: { model?: string | null | undefined; maxIterations?: number | undefined }) {
    return this.update((state) => {
      if (!state.goal) throw new Error("No goal is configured");
      return { ...state, goal: goalSchema.parse({ ...state.goal, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)), revision: state.goal.revision + 1, updatedAt: new Date().toISOString() }) };
    });
  }
  async beginTurn() {
    return this.update((state) => {
      if (state.turnActive) throw new Error("Continue or finish the previous goal/rubric turn before starting another prompt");
      return { ...state, turnActive: true, goal: state.goal?.status === "active" ? { ...state.goal, iterations: 0, assessment: null } : state.goal, rubric: state.rubric ? { ...state.rubric, iterations: 0, assessment: null } : null };
    });
  }
  async finishTurn() {
    return this.update((state) => ({ ...state, turnActive: false, rubric: state.rubric?.scope === "next" ? state.previousRubric : state.rubric, previousRubric: null }));
  }
  async setRubric(criteria: string[] | null, scope: "session" | "next" = "session") {
    return this.update((state) => ({ ...state, previousRubric: criteria && scope === "next" ? state.rubric?.scope === "session" ? state.rubric : state.previousRubric : null, rubric: criteria === null ? null : rubricSchema.parse({ ...state.rubric, criteria, scope, iterations: 0, assessment: null }) }));
  }
  async configureRubric(options: { model?: string | null | undefined; maxIterations?: number | undefined }) {
    return this.update((state) => {
      if (!state.rubric) throw new Error("Set rubric criteria first");
      return { ...state, rubric: rubricSchema.parse({ ...state.rubric, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) }) };
    });
  }
  async assess(target: "goal" | "rubric", assessment: z.infer<typeof assessmentSchema>) {
    return this.update((state) => {
      const current = state[target];
      if (!current || current.iterations >= current.maxIterations) throw new Error("No grading budget remains");
      const result = assessmentSchema.parse(assessment);
      if (result.criteria.length !== current.criteria.length || result.criteria.some((item, index) => item.criterion !== current.criteria[index])) throw new Error("Assessment must address every configured criterion in order");
      if (target === "goal") return { ...state, goal: { ...state.goal!, assessment: result, iterations: current.iterations + 1, revision: state.goal!.revision + 1, updatedAt: new Date().toISOString() } };
      return { ...state, rubric: { ...state.rubric!, assessment: result, iterations: current.iterations + 1 } };
    });
  }
  async updateGoal(update: z.infer<typeof goalUpdateSchema>) {
    return this.update((state) => {
      if (!state.goal) throw new Error("No goal is configured");
      if (state.goal.status === "complete") throw new Error("Completed goals are terminal; create a new goal");
      return { ...state, goal: { ...state.goal, ...goalUpdateSchema.parse(update), revision: state.goal.revision + 1, updatedAt: new Date().toISOString() } };
    });
  }
  tools() {
    return [
      tool(() => JSON.stringify(this.snapshot()), { name: "session_context", description: "Read user-approved session memory and the current goal.", schema: z.object({}) }),
      tool(async (update) => JSON.stringify(await this.updateGoal(update)), { name: "update_goal", description: "Propose a goal progress or completion update with evidence. Requires approval.", schema: goalUpdateSchema }),
    ];
  }
}
