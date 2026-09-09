import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { afterEach, describe, expect, it } from "vitest";
import { approvalRequests, approvalResume, createInterruptPolicy } from "../../src/code/runtime/approvals.js";
import { SessionStore } from "../../src/code/persistence/sessions.js";
import { modelSettings } from "../../src/code/runtime/model.js";
import { terminalText } from "../../src/code/shared/output.js";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "dcode-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const interrupt = {
  id: "interrupt-1",
  value: {
    actionRequests: [{ name: "write_file", args: { file_path: "/a", content: "hello" } }],
    reviewConfigs: [{ actionName: "write_file", allowedDecisions: ["approve", "reject"] }],
  },
};

describe("coding-agent approval boundaries", () => {
  it("validates approval requests and binds decisions to interrupt IDs", () => {
    const requests = approvalRequests([interrupt]);
    expect(approvalResume(requests, { "interrupt-1": [{ type: "approve" }] })).toEqual({
      "interrupt-1": { decisions: [{ type: "approve" }] },
    });
  });
  it("rejects malformed, missing, extra, and disallowed decisions", () => {
    const requests = approvalRequests([interrupt]);
    expect(() => approvalRequests([{ id: "x", value: {} }])).toThrow();
    expect(() => approvalResume(requests, {})).toThrow();
    expect(() => approvalResume(requests, { "interrupt-1": [] })).toThrow();
    expect(() => approvalResume(requests, { "interrupt-1": [{ type: "approve" }], extra: [] })).toThrow();
    expect(() => approvalResume(requests, { "interrupt-1": [{ type: "edit" }] })).toThrow();
    expect(() => approvalRequests([interrupt, interrupt])).toThrow();
  });
  it("gates shell, writes, deletion, and delegation by default", () => {
    const policy = createInterruptPolicy();
    for (const name of ["execute", "write_file", "edit_file", "delete", "task"]) {
      expect(policy[name]).toEqual({ allowedDecisions: ["approve", "reject", "edit"] });
    }
  });
});

describe("durable coding-agent sessions", () => {
  it("persists graph messages and pending writes across independent store instances", async () => {
    const root = await temporaryDirectory();
    const store = new SessionStore(root);
    const session = await store.create({ cwd: root, model: "test-model" });
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: [new HumanMessage("remember this")] };
    await store.use(session.id, async ({ checkpointer, config }) => {
      const saved = await checkpointer.put(config, checkpoint, { source: "input", step: -1, parents: {} });
      await checkpointer.putWrites(saved, [["approval", { requested: true }]], "task-1");
    });
    await new SessionStore(root).use(session.id, async ({ checkpointer, config }) => {
      const saved = await checkpointer.getTuple(config);
      expect(saved?.checkpoint.channel_values.messages).toEqual([new HumanMessage("remember this")]);
      expect(saved?.pendingWrites).toEqual([["task-1", "approval", { requested: true }]]);
    });
    expect((await store.list())[0]?.id).toBe(session.id);
    expect((await stat(join(root, session.id, "checkpoint.json"))).mode & 0o777).toBe(0o600);
  });
  it("serializes writers across store instances and releases locks on failure", async () => {
    const root = await temporaryDirectory();
    const store = new SessionStore(root);
    const session = await store.create({ cwd: root, model: "test-model" });
    await expect(store.use(session.id, async () => {
      await expect(new SessionStore(root).use(session.id, async () => undefined)).rejects.toThrow(/in use/);
      throw new Error("test failure");
    })).rejects.toThrow("test failure");
    await expect(store.use(session.id, async () => "released")).resolves.toBe("released");
  });
  it("does not overwrite corrupt checkpoints or accept path traversal", async () => {
    const root = await temporaryDirectory();
    const store = new SessionStore(root);
    const session = await store.create({ cwd: root, model: "test-model" });
    const path = join(root, session.id, "checkpoint.json");
    await writeFile(path, "not json");
    await expect(store.use(session.id, async () => undefined)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("not json");
    await expect(store.get("../../elsewhere")).rejects.toThrow(/session ID/i);
  });
  it("rejects symlinked session directories", async () => {
    const root = await temporaryDirectory();
    const target = await temporaryDirectory();
    const id = "00000000-0000-4000-8000-000000000000";
    await symlink(target, join(root, id));
    await expect(new SessionStore(root).get(id)).rejects.toThrow(/symlink|directory/i);
  });
});

describe("coding-agent model and terminal configuration", () => {
  it("requires an explicit model and isolates custom endpoint credentials", () => {
    expect(() => modelSettings({}, {})).toThrow(/model/i);
    expect(() => modelSettings({ model: "test", baseUrl: "https://gateway.example/v1" }, { OPENAI_API_KEY: "not-for-gateway" })).toThrow(/DCODE_API_KEY/);
    expect(modelSettings({ model: "test" }, { OPENAI_API_KEY: "test-key" })).toMatchObject({ model: "test", apiKey: "test-key" });
    expect(() => modelSettings({ model: "test", baseUrl: "http://remote.example/v1" }, { DCODE_API_KEY: "test-key" })).toThrow(/HTTPS/);
  });
  it("removes terminal escapes and bidi overrides while retaining plain text", () => {
    expect(terminalText("hello\u001b[2J\u001b]52;c;payload\u0007world\u202e\n")).toBe("helloworld\n");
  });
});
