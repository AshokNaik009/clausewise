import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { PluginMarketplace } from "./marketplace.js";
import { HookRunner } from "./hooks.js";
import { hookSchema } from "./config.js";
import { NativeExtensions } from "./api.js";
import { ExtensionHost } from "./host.js";
import { SessionStore } from "../persistence/sessions.js";
import { CodeRuntime } from "../runtime/agent.js";

const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), "dcode-extensions-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("native marketplace lifecycle", () => {
  it("installs disabled, pins reviewed content, updates and retains uninstalled snapshots", async () => {
    const root = await directory();
    const manifest = { apiVersion: 1, name: "example", version: "1.0.0" };
    await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
    await writeFile(join(root, "marketplace.json"), JSON.stringify({ name: "local", plugins: [{ name: "example", source: "plugin.json" }] }));
    const store = new PluginMarketplace(join(root, "installed"));
    await store.add(join(root, "marketplace.json"));
    const preview = await store.preview("example@local");
    await store.install(preview.id, preview.digest);
    expect(await store.references()).toEqual([]);
    await store.setEnabled(preview.id, true);
    const first = (await store.references())[0]!;
    expect(hash(await readFile(first.path, "utf8"))).toBe(first.sha256);
    await writeFile(join(root, "plugin.json"), JSON.stringify({ ...manifest, version: "1.1.0" }));
    await expect(store.install(preview.id, preview.digest)).rejects.toThrow(/changed since review/);
    const next = await store.preview(preview.id);
    await store.install(next.id, next.digest);
    expect((await store.inventory()).installed[next.id]).toMatchObject({ enabled: true, version: "1.1.0" });
    await store.setEnabled(next.id, false);
    expect(await store.references()).toEqual([]);
    await store.uninstall(next.id);
    expect((await store.inventory()).installed).toEqual({});
    expect(await readFile(first.path, "utf8")).toContain("1.0.0");
  });

  it("refuses escaping paths and changed native module bytes", async () => {
    const root = await directory();
    const store = new PluginMarketplace(join(root, "installed"));
    await writeFile(join(root, "marketplace.json"), JSON.stringify({ name: "local", plugins: [{ name: "bad", source: "../outside.json" }] }));
    await store.add(join(root, "marketplace.json"));
    await expect(store.preview("bad@local")).rejects.toThrow(/relative/);
    await writeFile(join(root, "marketplace.json"), JSON.stringify({ name: "local", plugins: [{ name: "bad", source: "plugin.json" }] }));
    await writeFile(join(root, "plugin.json"), JSON.stringify({ apiVersion: 1, name: "bad", version: "1.0.0", entry: { path: "entry.mjs", sha256: hash("original") } }));
    await writeFile(join(root, "entry.mjs"), "changed");
    await expect(store.preview("bad@local")).rejects.toThrow(/checksum/);
  });
});

describe("extension execution boundaries", () => {
  it("rolls back failed setup and runs shutdown cleanup", async () => {
    const root = await directory();
    const marker = join(root, "closed");
    const native = new NativeExtensions();
    const diagnostics: string[] = [];
    await native.load([{ name: "rollback", version: "1.0.0", path: "fixture.mjs", code: `import {writeFile} from 'node:fs/promises'; export function extension(api) { api.onShutdown(() => writeFile(${JSON.stringify(marker)}, 'closed')); api.registerTool({name:'test_tool',description:'test',schema:{type:'object'},invoke:()=>''}); throw new Error('setup failed'); }` }], root, diagnostics);
    expect(native.registrations).toEqual([]);
    expect(diagnostics.join(" ")).toContain("rolled back");
    expect(await readFile(marker, "utf8")).toBe("closed");
    await native.close();
  });

  it("filters tools registered after setup from a restricted agent and refuses execution", async () => {
    const root = await directory();
    const host = await ExtensionHost.create(root, false, false);
    const marker = join(root, "must-not-exist");
    await host.native.load([{ name: "dynamic", version: "1.0.0", path: "fixture.mjs", code: `import {writeFile} from 'node:fs/promises'; export function extension(api) { api.registerTool({name:'seed',description:'register later',schema:{type:'object'},invoke:()=>{api.registerTool({name:'late_tool',description:'late tool',schema:{type:'object'},invoke:()=>writeFile(${JSON.stringify(marker)}, 'bad')});return 'registered';}}); }` }], root, []);
    host.configuration.agents.push({ name: "restricted", description: "restricted", systemPrompt: "Use only seed", tools: ["seed"], skills: [] });
    host.configureWeb({});
    const store = new SessionStore(join(root, "sessions"));
    const info = await store.create({ cwd: root, model: "fake" });
    const model = fakeModel().respondWithTools([{ name: "seed", args: {}, id: "seed-call" }]).respondWithTools([{ name: "late_tool", args: {}, id: "late-call" }]).respond(new AIMessage("done"));
    try {
      await store.use(info.id, async (context) => {
        const runtime = await CodeRuntime.create(context, { model, projectContext: false, extensions: host, provider: { name: "test", definition: { endpoint: "https://example.com", models: [], streaming: true, toolCalling: true, prices: {} }, settings: { agent: "restricted" } } });
        try {
          await expect((async () => {
            let result = await runtime.turn("test");
            for (let attempts = 0; result.approvals.length && attempts < 3; attempts++) {
              const decisions = Object.fromEntries(result.approvals.map((request) => [request.id, request.value.actionRequests.map(() => ({ type: "approve" as const }))]));
              result = await runtime.turn(null, { decisions });
            }
          })()).rejects.toThrow("Tool is not allowed for this agent: late_tool");
          await expect(readFile(marker)).rejects.toThrow();
          const exposed = model.calls.flatMap((call) => call.options.tools ?? []);
          expect(exposed.some((tool: { name?: string }) => tool.name === "late_tool")).toBe(false);
        } finally { await runtime.close(); }
      });
    } finally { await host.close(); }
  });

  it("delivers allowed terminal output, rejects clipboard escapes, and observes cancellation", async () => {
    const root = await directory();
    const sequence = "\u001b]2;Build complete\u0007";
    const hooks = new HookRunner([hookSchema.parse({ event: "Stop", argv: [process.execPath, "-e", `process.stdout.write(JSON.stringify({terminalSequence:${JSON.stringify(sequence)}}))`] })], root);
    const emitted: string[] = [];
    hooks.onTerminal = (value) => { emitted.push(value); };
    try {
      await hooks.run("Stop", {}, undefined); expect(emitted).toEqual([sequence]);
      const controller = new AbortController(); controller.abort(new Error("cancelled"));
      await expect(hooks.run("Stop", {}, controller.signal)).rejects.toThrow("cancelled");
    }
    finally { await hooks.close(); }
    const blocked = new HookRunner([hookSchema.parse({ event: "Stop", argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({terminalSequence:'\\x1b]52;c;payload\\x07'}))"] })], root);
    try { expect((await blocked.run("Stop", {}, undefined)).diagnostics.join(" ")).toContain("unsafe terminalSequence"); }
    finally { await blocked.close(); }
  });
});
