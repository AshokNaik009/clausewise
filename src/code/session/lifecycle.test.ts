import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { encode, ExtData } from "@msgpack/msgpack";
import { once } from "node:events";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../persistence/sessions.js";
import { CodeRuntime } from "../runtime/agent.js";
import { ApprovalPolicy } from "../runtime/approval-mode.js";
import { GATED_TOOLS } from "../runtime/approvals.js";
import { planningPrompt } from "../runtime/prompt.js";
import { SessionControls } from "./controls.js";
import { readArchive, listArchives } from "./archives.js";
import { atomicJson } from "../persistence/storage.js";
import { importPythonSession, pythonMessages } from "../persistence/python-import.js";

const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), "dcode-lifecycle-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const grade = (criterion: string, verdict: "met" | "unmet" | "unknown") => new AIMessage(JSON.stringify({ criteria: [{ criterion, verdict, evidence: "Recorded test evidence" }], summary: verdict }));

describe("goal and rubric lifecycle", () => {
  it("preserves next-turn criteria across reload and restores sticky criteria", async () => {
    const root = await directory();
    const controls = await SessionControls.load(root);
    await controls.setRubric(["sticky"]);
    await controls.setRubric(["once"], "next");
    await controls.beginTurn();
    const loaded = await SessionControls.load(root);
    expect(loaded.snapshot()).toMatchObject({ turnActive: true, rubric: { criteria: ["once"] }, previousRubric: { criteria: ["sticky"] } });
    await loaded.finishTurn();
    expect(loaded.snapshot()).toMatchObject({ turnActive: false, rubric: { criteria: ["sticky"] }, previousRubric: null });
  });

  it("revises automatically, keeps tool approval, and finishes only after a met assessment", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const info = await store.create({ cwd: root, model: "fake" });
    const model = fakeModel().respond(new AIMessage("Initial answer")).respond(grade("works", "unmet"))
      .respondWithTools([{ name: "write_file", args: { file_path: "/result.txt", content: "value" }, id: "write-1" }])
      .respond(new AIMessage("Revised answer")).respond(grade("works", "met"));
    await store.use(info.id, async (context) => {
      const runtime = await CodeRuntime.create(context, { model, projectContext: false });
      try {
        await runtime.controls!.setGoal("Fix it", ["works"]);
        const first = await runtime.turn("Fix it");
        expect(first.status).toBe("interrupted");
        expect(runtime.controls!.snapshot().turnActive).toBe(true);
        const decisions = Object.fromEntries(first.approvals.map((request) => [request.id, request.value.actionRequests.map(() => ({ type: "reject" as const, message: "Do not write" }))]));
        expect((await runtime.turn(null, { decisions })).status).toBe("completed");
        expect(runtime.controls!.snapshot()).toMatchObject({ turnActive: false, goal: { status: "complete", iterations: 2 } });
        const completed = runtime.controls!.snapshot().goal;
        await runtime.controls!.beginTurn();
        expect(runtime.controls!.snapshot().goal).toEqual(completed);
        await runtime.controls!.finishTurn();
        await expect(readFile(join(root, "result.txt"))).rejects.toThrow();
      } finally { await runtime.close(); }
    });
  });

  it("stops on the explicit iteration cap without claiming success", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const info = await store.create({ cwd: root, model: "fake" });
    const model = fakeModel().respond(new AIMessage("answer")).respond(grade("works", "unknown"));
    await store.use(info.id, async (context) => {
      const runtime = await CodeRuntime.create(context, { model, projectContext: false });
      try {
        await runtime.controls!.setGoal("Fix it", ["works"]);
        await runtime.controls!.configureGoal({ maxIterations: 1 });
        await runtime.turn("Fix it");
        expect(model.callCount).toBe(2);
        expect(runtime.controls!.snapshot().goal).toMatchObject({ status: "active", iterations: 1, assessment: { summary: "unknown" } });
      } finally { await runtime.close(); }
    });
  });
});

describe("non-destructive session recovery", () => {
  it("refuses live or foreign locks and archives a dead local owner", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const info = await store.create({ cwd: root, model: "fake" });
    const lock = join(root, info.id, "session.lock");
    await store.use(info.id, async () => { await expect(store.recoverLock(info.id)).rejects.toThrow(/alive/); });
    await atomicJson(lock, { pid: process.pid, host: "other-host" });
    await expect(store.recoverLock(info.id)).rejects.toThrow(/another host/);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid!;
    await once(child, "exit");
    await atomicJson(lock, { pid, host: hostname() });
    const recovered = await store.recoverLock(info.id);
    expect(JSON.parse(await readFile(recovered.archive, "utf8")).pid).toBe(pid);
    await expect(store.use(info.id, async () => "ok")).resolves.toBe("ok");
  });

  it("restores archived history into a fresh idle graph without running tools", async () => {
    const root = await directory();
    const id = "00000000-0000-4000-8000-000000000001";
    const messages = [new HumanMessage("Original request"), new AIMessage("Original answer")];
    await atomicJson(join(root, `compaction-${id}.json`), { version: 1, checkpointId: "old", messages: messages.map((message) => message.toDict()), summary: "summary", createdAt: new Date().toISOString() });
    expect((await listArchives(root))[0]?.id).toBe(id);
    const archive = await readArchive(root, id);
    const store = new SessionStore(join(root, "sessions"));
    const info = await store.createFromHistory({ cwd: root, model: "fake" }, archive.restored, { source: id });
    await store.use(info.id, async (context) => {
      const model = fakeModel();
      const runtime = await CodeRuntime.create(context, { model, projectContext: false });
      try {
        expect((await runtime.result()).status).toBe("completed");
        expect(await runtime.history()).toEqual([{ role: "human", text: "Original request" }, { role: "ai", text: "Original answer" }]);
        expect(model.callCount).toBe(0);
      } finally { await runtime.close(); }
    });
    expect(await readFile(join(root, `compaction-${id}.json`), "utf8")).toContain("Original request");
  });

  it("imports SQLite MessagePack history read-only without Python deserialization", async () => {
    const root = await directory();
    const database = join(root, "python.db");
    const message = new ExtData(5, encode(["langchain_core.messages.human", "HumanMessage", { content: "Python history", type: "human" }]));
    const bytes = Buffer.from(encode({ channel_values: { messages: [message] } })).toString("hex");
    await promisify(execFile)("sqlite3", [database, `CREATE TABLE checkpoints(thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, type TEXT, checkpoint BLOB); INSERT INTO checkpoints VALUES('thread', '', 'checkpoint-1', 'msgpack', X'${bytes}');`]);
    const before = await readFile(database);
    const store = new SessionStore(join(root, "sessions"));
    const imported = await importPythonSession(store, database, "thread", { cwd: root, model: "fake" });
    await store.use(imported.id, async ({ checkpointer, config }) => {
      const checkpoint = await checkpointer.getTuple(config);
      expect(checkpoint?.checkpoint.channel_values.messages).toEqual([new HumanMessage("Python history")]);
    });
    expect(await readFile(database)).toEqual(before);
  });

  it("imports Python JSON without interpreting constructors or replaying pending calls", async () => {
    const root = await directory();
    const source = join(root, "python.json");
    const checkpoint = { channel_values: { messages: [{ lc: 1, type: "constructor", id: ["langchain", "schema", "messages", "HumanMessage"], kwargs: { content: "Historical request" } }] } };
    const text = JSON.stringify(checkpoint);
    await writeFile(source, text);
    const session = await importPythonSession(new SessionStore(join(root, "sessions")), source, "thread", { cwd: root, model: "fake" });
    expect(session.model).toBe("fake");
    expect(await readFile(source, "utf8")).toBe(text);
    expect(() => pythonMessages({ channel_values: { messages: [{ lc: 1, type: "constructor", id: ["os", "system"], kwargs: { content: "not code" } }] } })).toThrow(/namespace/);
    expect(() => pythonMessages({ channel_values: { messages: [{ type: "ai", content: "", tool_calls: [{ id: "pending", name: "execute", args: {} }] }] } })).toThrow(/pending tool/);
  });
});

describe("plan mode", () => {
  const request = (...names: string[]) => ({
    id: `interrupt-${names.join("-")}`,
    value: {
      actionRequests: names.map((name) => ({ name, args: { file_path: "/notes.txt", content: "value" } })),
      reviewConfigs: names.map((name) => ({ actionName: name, allowedDecisions: ["approve", "reject", "edit"] as ("approve" | "reject" | "edit")[] })),
    },
  });
  const context = (root: string) => ({ cwd: root, userRequest: "Plan the change", model: fakeModel(), ledger: undefined, signal: new AbortController().signal });

  it("rejects mutating tools without approving anything", async () => {
    const policy = new ApprovalPolicy();
    policy.set("plan", undefined, false);
    expect(policy.automatic).toBe(false);
    expect(policy.resolving).toBe(true);
    const decisions = await policy.decide([request("write_file", "edit_file"), request("execute"), request("delete")], context("/tmp"));
    expect(Object.values(decisions ?? {}).flat()).toEqual(Array.from({ length: 4 }, () => ({ type: "reject", message: expect.stringContaining("Plan mode is active") })));
    expect(fakeModel().callCount).toBe(0);
  });

  it("leaves research and mixed batches to human review, and never gates read-only tools", async () => {
    const policy = new ApprovalPolicy();
    policy.set("plan", undefined, false);
    expect(await policy.decide([request("web_search")], context("/tmp"))).toBeUndefined();
    expect(await policy.decide([request("task")], context("/tmp"))).toBeUndefined();
    expect(await policy.decide([request("write_file", "web_search")], context("/tmp"))).toBeUndefined();
    for (const name of ["ls", "read_file", "glob", "grep"]) expect(GATED_TOOLS).not.toContain(name);
  });

  it("keeps a proposed write off disk and feeds the rejection back to the model", async () => {
    const root = await directory();
    const store = new SessionStore(root);
    const info = await store.create({ cwd: root, model: "fake" });
    const model = fakeModel()
      .respondWithTools([{ name: "write_file", args: { file_path: "/plan.txt", content: "value" }, id: "write-1" }])
      .respond(new AIMessage("Here is the plan instead."));
    await store.use(info.id, async (session) => {
      const runtime = await CodeRuntime.create(session, { model, projectContext: false });
      try {
        const first = await runtime.turn("Add a file", { guidance: planningPrompt() });
        expect(first.status).toBe("interrupted");
        const policy = new ApprovalPolicy();
        policy.set("plan", undefined, false);
        const decisions = await policy.decide(first.approvals, { cwd: root, userRequest: "Add a file", model, ledger: undefined, signal: new AbortController().signal });
        expect(decisions).toBeDefined();
        expect((await runtime.turn(null, { decisions: decisions! })).status).toBe("completed");
        await expect(readFile(join(root, "plan.txt"))).rejects.toThrow();
        const history = await runtime.history();
        expect(history[0]?.text).toContain("Plan mode is active for this turn");
        expect(history.at(-1)?.text).toBe("Here is the plan instead.");
      } finally { await runtime.close(); }
    });
  });
});
