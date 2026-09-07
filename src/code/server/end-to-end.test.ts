import { createServer } from "node:http";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../client/agent-client.js";
import { SessionStore } from "../persistence/sessions.js";
import { atomicJson } from "../persistence/storage.js";
import { executeCommand, type CommandUi } from "../tui/commands.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("builds the project and launches the compiled CLI without modifying the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-build-"));
  roots.push(root);
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  await atomicJson(join(root, "package.json"), { type: "module" });
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  await promisify(execFile)(process.execPath, [join(repository, "node_modules", "typescript", "bin", "tsc"), "-p", join(repository, "tsconfig.json"), "--outDir", root], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, "code", "cli.js"), "--version"], { timeout: 10_000 });
  expect(stdout.trim()).toBe("0.1.0");
}, 40_000);

it("runs goal grading, archive restore, and session switching through the child-process protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-e2e-"));
  roots.push(root);
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { role: string; content: string }[] };
    const system = body.messages.find((message) => message.role === "system")?.content ?? "";
    const content = system.includes("Evaluate only") ? JSON.stringify({ criteria: [{ criterion: "works", verdict: "met", evidence: "Fixture evidence" }], summary: "verified fixture" }) : system.includes("Summarize the supplied") ? "Historical fixture summary" : "Fixture answer";
    calls++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: `fixture-${calls}`, object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP server");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const config = join(root, "config.json");
  await atomicJson(config, { version: 1, settings: { projectContext: false }, providers: { fixture: { endpoint, apiKeyEnv: "DCODE_TEST_KEY", streaming: false, models: ["fixture"] } } });
  vi.stubEnv("DCODE_TEST_KEY", "local-fixture-not-a-credential");
  const store = new SessionStore(join(root, "sessions"));
  const original = await store.create({ cwd: root, model: "fixture", provider: "fixture", baseUrl: endpoint });
  let client: AgentClient | undefined;
  try {
    client = await AgentClient.start(store.directory, original.id, { configFile: config, projectContext: false });
    await client.setGoal("Fixture objective", ["works"]);
    const result = await client.turn("Complete the fixture objective");
    expect(result.status).toBe("completed");
    expect((await client.controls()).goal?.status).toBe("complete");
    expect(calls).toBe(2);
    await client.compact();
    expect(calls).toBe(3);
    const archives = await client.archives();
    expect(archives).toHaveLength(1);
    let accept: (() => Promise<void>) | undefined;
    let pickerCommand: string | null | undefined;
    const active = client;
    const ui: CommandUi = { client: active, print: () => undefined, select: async (id) => { await active.select(id); }, pick: (_title, _items, _choose, command) => { pickerCommand = command; }, confirm: (_title, _text, callback) => { accept = callback; }, run: async () => { throw new Error("Archive commands must not invoke the model"); }, auth: () => undefined, yolo: () => undefined };
    await executeCommand("archives", "", ui);
    expect(pickerCommand).toBe("/archives restore");
    await executeCommand("archives", `restore ${archives[0]!.id}`, ui);
    expect((await client.sessions())).toHaveLength(1);
    expect(accept).toBeTypeOf("function");
    await accept!();
    const restored = client.session;
    expect(restored.id).not.toBe(original.id);
    expect((await client.sessions()).map(({ id }) => id)).toContain(original.id);
    expect((await client.history()).map(({ text }) => text)).toEqual(["Complete the fixture objective", "Fixture answer"]);
    expect((await client.result()).costs?.requests).toBe(0);
    expect(calls).toBe(3);
    await client.close();
    client = undefined;
    await expect(store.use(restored.id, async () => "released")).resolves.toBe("released");
  } finally {
    await client?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 20_000);
