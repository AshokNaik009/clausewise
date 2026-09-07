import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { USER_CONFIG_DIRECTORY, endpointSchema, modelSelectionSchema } from "../config/configuration.js";
import { isMissing, readJson } from "../persistence/storage.js";

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const envKeys = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).max(50).default([]);
export const mcpServerSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).max(100).default([]), envKeys, disabled: z.boolean().default(false) }).strict(),
  z.object({ transport: z.literal("http"), url: endpointSchema, tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(), disabled: z.boolean().default(false) }).strict(),
]);
export type McpDefinition = z.infer<typeof mcpServerSchema>;
export const hookEventSchema = z.enum(["SessionStart", "SessionEnd", "UserPromptSubmit", "PermissionRequest", "Notification", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "Stop", "SubagentStart", "SubagentStop"]);
export const hookSchema = z.object({ event: hookEventSchema, matcher: z.string().max(1024).default("*"), argv: z.array(z.string()).min(1).max(100), envKeys, timeoutSeconds: z.number().positive().max(600).default(30), statusMessage: z.string().max(1000).optional(), legacyEvent: z.string().optional(), nativeMatcher: z.boolean().default(true), environment: z.record(z.string(), z.string()).default({}) }).strict().refine((value) => !["UserPromptSubmit", "Stop"].includes(value.event) || ["", "*"].includes(value.matcher), "This event does not have a matcher field");
export type HookDefinition = z.infer<typeof hookSchema>;
const wireHookSchema = z.object({ type: z.literal("command"), command: z.string().min(1).optional(), argv: z.array(z.string()).min(1).optional(), timeout: z.number().positive().max(600).nullish(), statusMessage: z.string().max(1000).optional(), async: z.literal(false).nullish() }).refine((handler) => handler.argv || handler.command, "A hook needs command or argv");
const hookFileSchema = z.object({ hooks: z.partialRecord(hookEventSchema, z.array(z.object({ matcher: z.string().nullish(), hooks: z.array(wireHookSchema).max(50) })).max(50)) });
const legacyEvents: Record<string, [z.infer<typeof hookEventSchema>, string]> = { "session.start": ["UserPromptSubmit", "*"], "user.prompt": ["UserPromptSubmit", "*"], "task.complete": ["Notification", "agent_completed"], "session.end": ["SessionEnd", "*"], "context.offload": ["PreCompact", "manual"], "context.compact": ["PreCompact", "manual"], "input.required": ["Notification", "agent_needs_input"] };

export function parseHookFile(value: unknown, diagnostics: string[] = []): HookDefinition[] {
  const legacy = z.object({ hooks: z.array(z.object({ command: z.array(z.string()).min(1), events: z.array(z.string()).nullish() })) }).safeParse(value);
  if (legacy.success) return legacy.data.hooks.flatMap((entry) => [...new Set(entry.events?.length ? entry.events : Object.keys(legacyEvents))].flatMap((name) => {
    const mapped = legacyEvents[name];
    if (!mapped) { diagnostics.push(`Unmapped legacy hook event: ${name}`); return []; }
    return [hookSchema.parse({ event: mapped[0], matcher: mapped[1], argv: entry.command, legacyEvent: name, nativeMatcher: false })];
  }));
  const file = hookFileSchema.parse(value);
  return Object.entries(file.hooks).flatMap(([event, groups]) => (groups ?? []).flatMap((group) => group.hooks.flatMap((handler) => {
    const parsed = hookSchema.safeParse({ event, matcher: group.matcher || "*", timeoutSeconds: handler.timeout ?? (event === "UserPromptSubmit" ? 30 : 600), statusMessage: handler.statusMessage, nativeMatcher: false, argv: handler.argv ?? (process.platform === "win32" ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", handler.command!] : ["/bin/sh", "-c", handler.command!]) });
    if (!parsed.success) { diagnostics.push(`Invalid ${event} hook group was excluded`); return []; }
    return [parsed.data];
  })));
}
export const agentSchema = z.object({
  name: name.refine((value) => value !== "general-purpose"), description: z.string().min(1).max(2000), systemPrompt: z.string().min(1).max(16_000),
  skills: z.array(z.string().regex(/^\/(?!.*\.\.)[^\\]+$/u)).max(20).default([]),
  model: modelSelectionSchema.optional(), tools: z.array(z.string().min(1).max(128)).max(200).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
}).strict();
const contributions = {
  mcp: z.record(name, mcpServerSchema).default({}), hooks: z.array(hookSchema).max(50).default([]), agents: z.array(agentSchema).max(20).default([]),
};
const fileReference = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const pluginSchema = z.object({ apiVersion: z.literal(1), name, version: z.string().regex(/^\d+\.\d+\.\d+$/u), entry: fileReference.optional(), ...contributions }).strict();
export type ExtensionManifest = z.infer<typeof pluginSchema>;
const configurationSchema = z.object({ version: z.literal(1), ...contributions, plugins: z.array(fileReference).max(20).default([]) }).strict();
export interface ExtensionModule { name: string; version: string; path: string; code: string }
export interface ExtensionConfiguration { mcp: Record<string, McpDefinition>; hooks: HookDefinition[]; agents: z.infer<typeof agentSchema>[]; modules: ExtensionModule[]; sources: string[]; diagnostics: string[] }

async function verifiedFile(rootPath: string, reference: z.infer<typeof fileReference>): Promise<{ target: string; bytes: Buffer }> {
  if (isAbsolute(reference.path)) throw new Error("Plugin files must be relative to their trusted root");
  const root = await realpath(rootPath);
  const target = await realpath(join(root, reference.path));
  if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) throw new Error("Plugin file escapes its trusted root");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_000_000) throw new Error("Plugin file exceeds its size limit");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length > 1_000_000 || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error("Plugin file checksum or size mismatch");
  return { target, bytes };
}

export async function loadExtensions(cwd: string, trusted: boolean, projectContext: boolean): Promise<ExtensionConfiguration> {
  const result: ExtensionConfiguration = { mcp: {}, hooks: [], agents: [], modules: [], sources: [], diagnostics: [] };
  const pluginHooks: HookDefinition[] = [];
  const paths = [...(projectContext ? [join(cwd, ".deepagents", "extensions.json")] : []), join(USER_CONFIG_DIRECTORY, "extensions.json")];
  const merge = (contribution: Pick<ExtensionConfiguration, "mcp" | "hooks" | "agents">) => {
    for (const [key, value] of Object.entries(contribution.mcp)) { if (Object.hasOwn(result.mcp, key)) throw new Error(`Duplicate MCP server name: ${key}`); result.mcp[key] = value; }
    for (const agent of contribution.agents) { if (result.agents.some(({ name }) => name === agent.name)) throw new Error(`Duplicate agent name: ${agent.name}`); result.agents.push(agent); }
    result.hooks.push(...contribution.hooks);
  };
  const loadPlugin = async (root: string, plugin: z.infer<typeof fileReference>) => {
    const { target, bytes } = await verifiedFile(root, plugin);
    const manifest = pluginSchema.parse(JSON.parse(bytes.toString("utf8")));
    merge({ ...manifest, hooks: [] });
    pluginHooks.push(...manifest.hooks);
    if (manifest.entry) {
      const entry = await verifiedFile(dirname(target), manifest.entry);
      if (!entry.target.endsWith(".mjs")) throw new Error("Native plugin entries must be bundled .mjs modules");
      if (result.modules.some(({ name }) => name === manifest.name)) throw new Error(`Duplicate native plugin: ${manifest.name}`);
      result.modules.push({ name: manifest.name, version: manifest.version, path: entry.target, code: entry.bytes.toString("utf8") });
    }
    result.sources.push(`${manifest.name}@${manifest.version}: ${target}`);
  };
  for (const path of paths) {
    const hookPaths = [join(dirname(path), "hooks.json"), ...(path === join(USER_CONFIG_DIRECTORY, "extensions.json") ? [join(homedir(), ".deepagents", "hooks.json")] : [])];
    for (const hookPath of hookPaths) {
      let raw: unknown;
      try { raw = await readJson(hookPath); } catch (error) { if (isMissing(error)) continue; if (!trusted) { result.diagnostics.push(`Disabled hooks are unreadable: ${hookPath}`); continue; } throw error; }
      if (!trusted) { result.diagnostics.push(`Hooks disabled until --trust-extensions: ${hookPath}`); continue; }
      if (JSON.stringify(raw).length > 1_000_000) throw new Error("Hook configuration exceeds 1 MB");
      result.hooks.push(...parseHookFile(raw, result.diagnostics));
      result.sources.push(hookPath);
    }
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
    for (const plugin of configuration.plugins) await loadPlugin(dirname(path), plugin);
  }
  if (trusted) {
    const { PluginMarketplace } = await import("./marketplace.js");
    for (const plugin of await new PluginMarketplace().references()) await loadPlugin(dirname(plugin.path), { ...plugin, path: "manifest.json" });
  }
  result.hooks.push(...pluginHooks);
  if (Object.keys(result.mcp).length > 20 || result.hooks.length > 100 || result.agents.length > 40) throw new Error("Combined integration configuration exceeds its limits");
  return result;
}
