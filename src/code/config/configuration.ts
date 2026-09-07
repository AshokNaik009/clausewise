import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isMissing, readJson } from "../persistence/storage.js";
import { priceSchema } from "../protocol/session-controls.js";

export const USER_CONFIG_DIRECTORY = join(homedir(), ".config", "dcode-ts");
export const endpointSchema = z.string().url().transform((value) => value.replace(/\/+$/u, "")).refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash;
}, "Endpoints require HTTPS (or loopback HTTP), without credentials, query, or fragment");
export const providerSchema = z.object({
  endpoint: endpointSchema,
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
  models: z.array(z.string().min(1).max(200)).max(200).default([]),
  streaming: z.boolean().default(true),
  toolCalling: z.boolean().default(true),
  prices: z.record(z.string(), priceSchema).default({}),
}).strict();
export type ProviderDefinition = z.infer<typeof providerSchema>;
const settingSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u).optional(),
  projectContext: z.boolean().optional(),
  shellTimeoutSeconds: z.number().int().min(1).max(900).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  timeoutSeconds: z.number().int().min(1).max(900).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  allowYolo: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  webFetch: z.boolean().optional(),
}).strict();
export type CodeSettings = z.infer<typeof settingSchema>;
const fileSchema = z.object({
  version: z.literal(1),
  settings: settingSchema.default({}),
  providers: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), providerSchema).default({}),
}).strict();
type FileConfig = z.infer<typeof fileSchema>;
interface Source { name: string; path: string; snapshot: FileConfig; loaded: boolean; healthy: boolean; diagnostic?: string }
export const configSnapshotSchema = z.object({ generation: z.number().int().nonnegative(), settings: settingSchema, provenance: z.record(z.string(), z.string()), sources: z.array(z.object({ name: z.string(), path: z.string(), healthy: z.boolean(), diagnostic: z.string().optional() })) });
export type ConfigSnapshot = z.infer<typeof configSnapshotSchema>;

export class Configuration {
  private generation = 0;
  private sources: Source[];
  private runtime: CodeSettings = {};
  constructor(cwd: string, private readonly cli: CodeSettings = {}, paths?: { managed: string; user: string; project: string }) {
    this.sources = [
      { name: "managed", path: paths?.managed ?? "/etc/dcode-ts/config.json" },
      { name: "user", path: paths?.user ?? join(USER_CONFIG_DIRECTORY, "config.json") },
      { name: "project", path: paths?.project ?? join(cwd, ".deepagents", "dcode.json") },
    ].map((source) => ({ ...source, snapshot: { version: 1, settings: {}, providers: {} }, loaded: false, healthy: true }));
  }

  async reload(): Promise<ConfigSnapshot> {
    const sources = await Promise.all(this.sources.map(async (source): Promise<Source> => {
      try {
        const snapshot = fileSchema.parse(await readJson(source.path));
        if (source.name === "project" && (Object.keys(snapshot.providers).length || snapshot.settings.provider || snapshot.settings.allowYolo !== undefined || snapshot.settings.webSearch !== undefined || snapshot.settings.webFetch !== undefined)) throw new Error("Project files cannot configure providers, unrestricted mode, or external web access");
        return { name: source.name, path: source.path, snapshot, loaded: true, healthy: true };
      } catch (error) {
        if (isMissing(error) && !source.loaded) return { name: source.name, path: source.path, snapshot: source.snapshot, loaded: false, healthy: true };
        return { ...source, healthy: false, diagnostic: "Source unavailable or invalid; retaining the last usable snapshot" };
      }
    }));
    const managed = sources.find((source) => source.name === "managed")!;
    if (!managed.healthy && this.generation === 0) throw new Error("Managed configuration is invalid; startup refused");
    this.sources = sources;
    this.generation++;
    return this.snapshot();
  }

  snapshot(env: NodeJS.ProcessEnv = process.env): ConfigSnapshot {
    const live = settingSchema.parse({ ...(env.DCODE_MODEL ? { model: env.DCODE_MODEL } : {}), ...(env.DCODE_PROVIDER ? { provider: env.DCODE_PROVIDER } : {}) });
    const defaults: CodeSettings = { provider: "openai", projectContext: true, shellTimeoutSeconds: 120, maxRetries: 2, timeoutSeconds: 120, allowYolo: true, webSearch: false, webFetch: false };
    const tiers = [
      ["managed", this.sources[0]!.snapshot.settings], ["cli", this.cli], ["runtime", this.runtime], ["environment", live],
      ["user", this.sources[1]!.snapshot.settings], ["project", this.sources[2]!.snapshot.settings], ["default", defaults],
    ] as const;
    const settings: Record<string, unknown> = {};
    const provenance: Record<string, string> = {};
    for (const [name, values] of tiers) for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && !Object.hasOwn(settings, key)) { settings[key] = value; provenance[key] = name; }
    }
    return { generation: this.generation, settings: settingSchema.parse(settings), provenance, sources: this.sources.map(({ snapshot: _snapshot, loaded: _loaded, ...source }) => source) };
  }

  fork(): Configuration {
    const copy = new Configuration(".", this.cli);
    copy.sources = structuredClone(this.sources);
    copy.generation = this.generation;
    copy.runtime = { ...this.runtime };
    return copy;
  }

  setRuntime(settings: CodeSettings): void { this.runtime = settingSchema.parse(settings); }

  providers(): Record<string, ProviderDefinition> {
    const builtins = { openai: providerSchema.parse({ endpoint: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" }) };
    return { ...builtins, ...this.sources[1]!.snapshot.providers, ...this.sources[0]!.snapshot.providers };
  }

  provider(name: string, endpoint?: string): ProviderDefinition {
    const provider = this.providers()[name];
    if (!provider) {
      if (name === "custom" && endpoint) return providerSchema.parse({ endpoint, apiKeyEnv: "DCODE_API_KEY" });
      throw new Error(`Unknown provider: ${name}`);
    }
    if (endpoint && endpointSchema.parse(endpoint) !== provider.endpoint) throw new Error("Stored endpoint differs from provider configuration; select the provider explicitly to switch");
    return provider;
  }
}
