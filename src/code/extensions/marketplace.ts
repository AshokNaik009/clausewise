import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { USER_CONFIG_DIRECTORY } from "../config/configuration.js";
import { atomicJson, atomicText, isMissing, privateDirectory, readJson } from "../persistence/storage.js";
import { acquireSessionLock } from "../persistence/locks.js";
import { pluginSchema } from "./config.js";

const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const catalogSchema = z.object({ name: nameSchema, plugins: z.array(z.object({ name: nameSchema, source: z.string().min(1), sha256: hashSchema.optional() })).max(200) });
const installedSchema = z.object({ name: nameSchema, marketplace: nameSchema, version: z.string(), digest: hashSchema, enabled: z.boolean(), installedAt: z.string().datetime() }).strict();
const stateSchema = z.object({ version: z.literal(1), marketplaces: z.record(nameSchema, z.string()), installed: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}@[a-z][a-z0-9_-]{0,31}$/u), installedSchema) }).strict();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function readText(path: string): Promise<string> {
  if (path.startsWith("https://")) {
    const url = new URL(path);
    if (url.username || url.password || url.search || url.hash) throw new Error("Marketplace URLs cannot include credentials, queries, or fragments");
    const { fetchPublicText } = await import("../tools/web.js");
    const result = await fetchPublicText(path);
    if (new URL(result.url).origin !== url.origin || !result.url.startsWith("https://")) throw new Error("Marketplace redirect changed origin or transport");
    if (Buffer.byteLength(result.content) > 1_000_000) throw new Error("Marketplace file exceeds 1 MB");
    return result.content;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_000_000) throw new Error("Marketplace file must be a regular file of at most 1 MB");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function resolveSource(parent: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || /^[a-z]+:/iu.test(path)) throw new Error("Plugin sources must stay relative to their marketplace root");
  if (parent.startsWith("https://")) {
    const root = new URL(".", parent);
    const target = new URL(path, root);
    if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.search || target.hash) throw new Error("Plugin source escapes its marketplace");
    return target.href;
  }
  const root = await realpath(dirname(parent));
  const target = await realpath(join(root, path));
  const child = relative(root, target);
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("Plugin source escapes its marketplace");
  return target;
}

export class PluginMarketplace {
  constructor(readonly directory = join(USER_CONFIG_DIRECTORY, "plugins")) {}
  private async state() {
    try { return stateSchema.parse(await readJson(join(this.directory, "registry.json"))); }
    catch (error) { if (!isMissing(error)) throw error; return stateSchema.parse({ version: 1, marketplaces: {}, installed: {} }); }
  }
  private async mutate(change: (state: z.infer<typeof stateSchema>) => Promise<void>) {
    await privateDirectory(this.directory);
    const release = await acquireSessionLock(join(this.directory, "registry.lock"));
    try { const state = await this.state(); await change(state); await atomicJson(join(this.directory, "registry.json"), stateSchema.parse(state)); return state; }
    finally { await release(); }
  }
  async inventory() { return this.state(); }
  async add(source: string) {
    const path = source.startsWith("https://") ? source : await realpath(source);
    const catalog = catalogSchema.parse(JSON.parse(await readText(path)));
    if (new Set(catalog.plugins.map(({ name }) => name)).size !== catalog.plugins.length) throw new Error("Marketplace contains duplicate plugin names");
    return this.mutate(async (state) => {
      if (state.marketplaces[catalog.name] && state.marketplaces[catalog.name] !== path) throw new Error("Marketplace identity already belongs to another source");
      state.marketplaces[catalog.name] = path;
    });
  }
  async preview(id: string) {
    const [name, marketplace, extra] = id.split("@");
    if (extra !== undefined) throw new Error("Use plugin-name@marketplace-name");
    nameSchema.parse(name); nameSchema.parse(marketplace);
    const state = await this.state();
    const source = state.marketplaces[marketplace!];
    if (!source) throw new Error("Register the marketplace first");
    const catalog = catalogSchema.parse(JSON.parse(await readText(source)));
    if (catalog.name !== marketplace) throw new Error("Marketplace identity changed");
    const entry = catalog.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error("Plugin is absent from the marketplace");
    const path = await resolveSource(source, entry.source);
    const text = await readText(path);
    if (entry.sha256 && digest(text) !== entry.sha256) throw new Error("Marketplace plugin checksum mismatch");
    const manifest = pluginSchema.parse(JSON.parse(text));
    if (manifest.name !== name) throw new Error("Plugin identity differs from the marketplace entry");
    let code: string | undefined;
    if (manifest.entry) {
      if (!manifest.entry.path.endsWith(".mjs")) throw new Error("Port native extensions to a bundled .mjs entry; Python entries are not executed");
      code = await readText(await resolveSource(path, manifest.entry.path));
      if (digest(code) !== manifest.entry.sha256) throw new Error("Plugin entry checksum mismatch");
      manifest.entry.path = "entry.mjs";
    }
    const snapshot = JSON.stringify(manifest);
    return { id, marketplace: marketplace!, source: path, manifest, snapshot, digest: digest(snapshot), ...(code !== undefined ? { code } : {}) };
  }
  async install(id: string, expectedDigest: string) {
    const preview = await this.preview(id);
    if (preview.digest !== hashSchema.parse(expectedDigest)) throw new Error("Plugin changed since review; review it again");
    const snapshotDirectory = join(this.directory, "snapshots", preview.digest);
    await privateDirectory(snapshotDirectory);
    if (preview.code !== undefined) await atomicText(join(snapshotDirectory, "entry.mjs"), preview.code);
    await atomicText(join(snapshotDirectory, "manifest.json"), preview.snapshot);
    return this.mutate(async (state) => {
      const previous = state.installed[id];
      state.installed[id] = { name: preview.manifest.name, marketplace: preview.marketplace, version: preview.manifest.version, digest: preview.digest, enabled: previous?.enabled ?? false, installedAt: new Date().toISOString() };
    });
  }
  async setEnabled(id: string, enabled: boolean) {
    return this.mutate(async (state) => { if (!state.installed[id]) throw new Error("Plugin is not installed"); state.installed[id].enabled = enabled; });
  }
  async uninstall(id: string) {
    return this.mutate(async (state) => { if (!state.installed[id]) throw new Error("Plugin is not installed"); delete state.installed[id]; });
  }
  async references() {
    const state = await this.state();
    return Object.values(state.installed).filter(({ enabled }) => enabled).map((entry) => ({ path: join(this.directory, "snapshots", entry.digest, "manifest.json"), sha256: entry.digest }));
  }
}
