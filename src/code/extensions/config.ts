import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { USER_CONFIG_DIRECTORY, endpointSchema } from "../config/configuration.js";
import { isMissing, readJson } from "../persistence/storage.js";

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const envKeys = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).max(50).default([]);
export const mcpServerSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).max(100).default([]), envKeys, disabled: z.boolean().default(false) }).strict(),
  z.object({ transport: z.literal("http"), url: endpointSchema, tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(), disabled: z.boolean().default(false) }).strict(),
]);
export type McpDefinition = z.infer<typeof mcpServerSchema>;
export const hookSchema = z.object({ event: z.enum(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"]), matcher: z.string().max(100).default("*"), argv: z.array(z.string()).min(1).max(100), envKeys, timeoutSeconds: z.number().int().min(1).max(120).default(30) }).strict();
export type HookDefinition = z.infer<typeof hookSchema>;
export const agentSchema = z.object({ name: name.refine((value) => value !== "general-purpose"), description: z.string().min(1).max(2000), systemPrompt: z.string().min(1).max(16_000), skills: z.array(z.string().regex(/^\/(?!.*\.\.)[^\\]+$/u)).max(20).default([]) }).strict();
const contributions = {
  mcp: z.record(name, mcpServerSchema).default({}), hooks: z.array(hookSchema).max(50).default([]), agents: z.array(agentSchema).max(20).default([]),
};
export const pluginSchema = z.object({ apiVersion: z.literal(1), name, version: z.string().regex(/^\d+\.\d+\.\d+$/u), ...contributions }).strict();
export type ExtensionManifest = z.infer<typeof pluginSchema>;
const configurationSchema = z.object({ version: z.literal(1), ...contributions, plugins: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).max(20).default([]) }).strict();
export interface ExtensionConfiguration { mcp: Record<string, McpDefinition>; hooks: HookDefinition[]; agents: z.infer<typeof agentSchema>[]; sources: string[]; diagnostics: string[] }

export async function loadExtensions(cwd: string, trusted: boolean, projectContext: boolean): Promise<ExtensionConfiguration> {
  const result: ExtensionConfiguration = { mcp: {}, hooks: [], agents: [], sources: [], diagnostics: [] };
  const paths = [join(USER_CONFIG_DIRECTORY, "extensions.json"), ...(projectContext ? [join(cwd, ".deepagents", "extensions.json")] : [])];
  const merge = (contribution: Pick<ExtensionConfiguration, "mcp" | "hooks" | "agents">) => {
    for (const [key, value] of Object.entries(contribution.mcp)) { if (Object.hasOwn(result.mcp, key)) throw new Error(`Duplicate MCP server name: ${key}`); result.mcp[key] = value; }
    for (const agent of contribution.agents) { if (result.agents.some(({ name }) => name === agent.name)) throw new Error(`Duplicate agent name: ${agent.name}`); result.agents.push(agent); }
    result.hooks.push(...contribution.hooks);
  };
  for (const path of paths) {
    let raw: unknown;
    try { raw = await readJson(path); } catch (error) {
      if (isMissing(error)) continue;
      if (!trusted) { result.diagnostics.push(`Disabled integration configuration is unreadable: ${path}`); continue; }
      throw error;
    }
    if (!trusted) { result.diagnostics.push(`Integrations disabled: review ${path} and explicitly pass --trust-extensions to enable them.`); continue; }
    if (JSON.stringify(raw).length > 1_000_000) throw new Error("Extension configuration exceeds 1 MB");
    const configuration = configurationSchema.parse(raw);
    merge(configuration);
    result.sources.push(path);
    for (const plugin of configuration.plugins) {
      if (isAbsolute(plugin.path)) throw new Error("Plugin manifests must be relative to their configuration directory");
      const root = await realpath(dirname(path));
      const target = await realpath(join(root, plugin.path));
      if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) throw new Error("Plugin manifest escapes its trusted configuration directory");
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1_000_000) throw new Error("Plugin manifest exceeds its size limit");
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      if (bytes.length > 1_000_000 || createHash("sha256").update(bytes).digest("hex") !== plugin.sha256) throw new Error("Plugin manifest checksum or size mismatch");
      const manifest = pluginSchema.parse(JSON.parse(bytes.toString("utf8")));
      merge(manifest);
      result.sources.push(`${manifest.name}@${manifest.version}: ${target}`);
    }
  }
  if (Object.keys(result.mcp).length > 20 || result.hooks.length > 100 || result.agents.length > 40) throw new Error("Combined integration configuration exceeds its limits");
  return result;
}
