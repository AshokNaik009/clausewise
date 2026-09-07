import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationUpdates, type PackageRunner } from "../cli/updates.js";
import { atomicJson, privateDirectory } from "../persistence/storage.js";
import { parseUpstreamConfiguration, upstreamEnvironment } from "./compatibility.js";
import { Configuration } from "./configuration.js";

const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), "dcode-config-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("upstream setting resolution", () => {
  it("preserves valid siblings and falls back from malformed values", () => {
    const diagnostics: string[] = [];
    expect(parseUpstreamConfiguration('[ui]\nshow_message_timestamps = true\nshow_scrollbar = "bad"\n[models]\ndefault = "broken"\nrecent = "test:valid"\n[update]\nauto_update = false\ncheck = false', diagnostics).settings).toEqual({ timestamps: true, model: "valid", provider: "test", autoUpdate: false, updateCheck: false });
    expect(diagnostics).toHaveLength(2);
    expect(upstreamEnvironment({ DEEPAGENTS_CODE_SHOW_MESSAGE_TIMESTAMPS: "not-a-boolean", DEEPAGENTS_CODE_AUTO_UPDATE: "off", DEEPAGENTS_CODE_NO_UPDATE_CHECK: "0", DEEPAGENTS_CODE_RECURSION_LIMIT: "100001" }, diagnostics)).toEqual({ autoUpdate: false, updateCheck: false });
    expect(diagnostics).toHaveLength(4);
  });
  it("rejects unimplemented settings rather than pretending to apply them", () => {
    expect(() => parseUpstreamConfiguration('[sandboxes]\ndefault = "remote"')).toThrow("Unsupported upstream setting: sandboxes");
    expect(() => parseUpstreamConfiguration('[models.providers.test]\nbase_url = "https://example.com"\napi_key = "not-supported"')).toThrow();
  });
  it("enforces managed precedence and retains last-good source generations", async () => {
    const root = await directory();
    const paths = { managed: join(root, "managed.toml"), user: join(root, "user.toml"), project: join(root, "project.json") };
    await writeFile(paths.managed, '[ui]\nshow_scrollbar = false');
    await writeFile(paths.user, '[ui]\nshow_scrollbar = true\nshow_message_timestamps = true');
    const config = new Configuration(root, {}, paths);
    expect((await config.reload()).settings).toMatchObject({ scrollbar: false, timestamps: true });
    await writeFile(paths.user, "invalid toml [");
    const snapshot = await config.reload();
    expect(snapshot.settings.timestamps).toBe(true);
    expect(snapshot.sources.find(({ name }) => name === "user")?.healthy).toBe(false);
    expect(() => config.patch("session", { scrollbar: true })).toThrow(/managed/);
  });
});

async function installation() {
  const root = await directory();
  const modules = join(root, "lib", "node_modules");
  const packageFile = join(modules, "dcode-fixture", "package.json");
  await privateDirectory(join(modules, "dcode-fixture"));
  const metadata = { name: "dcode-fixture", version: "1.0.0", bin: { "dcode-ts": "cli.js" } };
  await atomicJson(packageFile, metadata);
  const calls: string[][] = [];
  const published = { "1.1.0": new Date(Date.now() - 8 * 86_400_000).toISOString(), "1.2.0": new Date(Date.now() - 86_400_000).toISOString() };
  const run: PackageRunner = async (args) => {
    calls.push(args);
    if (args[0] === "prefix") return root;
    if (args[0] === "root") return modules;
    if (args[0] === "view") return JSON.stringify({ versions: ["1.0.0", "1.1.0", "1.2.0", "2.0.0-beta.1"], time: published });
    if (args[0] === "install") { await atomicJson(packageFile, { ...metadata, version: "1.1.0" }); return ""; }
    throw new Error("Unexpected package-manager command");
  };
  return { root, packageFile, run, calls };
}

describe("installation identity and update lifecycle", () => {
  it("does not call npm for private/source installations", async () => {
    const root = await directory();
    const file = join(root, "package.json");
    await atomicJson(file, { name: "reg-compare", version: "0.1.0", private: true });
    const updates = new ApplicationUpdates({ autoUpdate: true }, file, async () => { throw new Error("npm must not run"); });
    expect((await updates.check()).status.kind).toBe("development");
    await updates.automatic(() => { throw new Error("No startup action for source checkouts"); });
  });
  it("requires the reviewed plan, skips fresh releases, and reads back installation state", async () => {
    const fixture = await installation();
    const updates = new ApplicationUpdates({ updatePackage: "dcode-fixture" }, fixture.packageFile, fixture.run);
    const { plan } = await updates.check();
    expect(plan?.version).toBe("1.1.0");
    await expect(updates.apply(plan!, "yes")).rejects.toThrow(/acknowledgement/);
    await expect(updates.apply(plan!, "Update dcode-fixture to 1.1.0")).resolves.toMatchObject({ version: "1.1.0", restartRequired: true });
    expect(fixture.calls.find((args) => args[0] === "install")).toEqual(["install", "--global", "--prefix", fixture.root, "--ignore-scripts", "--", "dcode-fixture@1.1.0"]);
  });
  it("announces default auto-update once, skips that first install, and honors opt-out", async () => {
    const fixture = await installation();
    const updates = new ApplicationUpdates({ updatePackage: "dcode-fixture" }, fixture.packageFile, fixture.run);
    const notices: string[] = [];
    const noticeDirectory = join(fixture.root, "notices");
    await updates.automatic((message) => { notices.push(message); }, noticeDirectory);
    expect(notices[0]).toContain("first launch");
    expect(fixture.calls.some((args) => args[0] === "view")).toBe(false);
    await new ApplicationUpdates({ updatePackage: "dcode-fixture", autoUpdate: false }, fixture.packageFile, fixture.run).automatic(() => undefined, noticeDirectory);
    expect(fixture.calls.some((args) => args[0] === "install")).toBe(false);
    expect(await updates.automatic((message) => { notices.push(message); }, noticeDirectory)).toMatchObject({ version: "1.1.0" });
  });
});
