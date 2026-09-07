import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parse } from "smol-toml";
import { z } from "zod";

const modelSpec = z.string().regex(/^[a-z][a-z0-9_-]{0,63}:.{1,200}$/u).transform((value) => ({ provider: value.slice(0, value.indexOf(":")), model: value.slice(value.indexOf(":") + 1) }));
const provider = z.object({ base_url: z.string(), api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(), models: z.array(z.string()).max(200).optional() }).strict();
interface Option { path?: string; target: string; env?: string; schema: z.ZodType; presence?: boolean; invert?: boolean }
export const COMPATIBILITY_OPTIONS: readonly Option[] = [
  { path: "models.default", target: "selection", schema: modelSpec },
  { path: "models.recent", target: "selection", schema: modelSpec },
  { path: "models.allowed", target: "allowedModels", schema: z.array(z.string().regex(/^[a-z][a-z0-9_-]*:[^\s]+$/u)).max(200) },
  { path: "models.summarization_default", target: "summaryModel", schema: modelSpec },
  { path: "models.auto_classifier", target: "autoClassifierModel", env: "AUTO_CLASSIFIER_MODEL", schema: modelSpec },
  { path: "models.auto_classifier_timeout", target: "autoClassifierTimeout", env: "AUTO_CLASSIFIER_TIMEOUT", schema: z.number().min(1).max(300) },
  { path: "agents.default", target: "agent", schema: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,31}$/u) },
  { path: "agents.recent", target: "agent", schema: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,31}$/u) },
  { path: "retries.max_retries", target: "maxRetries", schema: z.number().int().min(0).max(5) },
  { path: "runtime.recursion_limit", target: "recursionLimit", env: "RECURSION_LIMIT", schema: z.number().int().min(25).max(100_000) },
  { path: "ui.theme", target: "theme", env: "THEME", schema: z.enum(["dark", "light", "plain"]) },
  { path: "ui.show_message_timestamps", target: "timestamps", env: "SHOW_MESSAGE_TIMESTAMPS", schema: z.boolean() },
  { path: "ui.show_diff_line_numbers", target: "lineNumbers", schema: z.boolean() },
  { path: "ui.show_scrollbar", target: "scrollbar", env: "SHOW_SCROLLBAR", schema: z.boolean() },
  { path: "ui.show_usage_stats", target: "showUsageStats", env: "SHOW_USAGE_STATS", schema: z.boolean() },
  { target: "terminalEscapes", env: "NO_TERMINAL_ESCAPE", schema: z.boolean(), invert: true },
  { target: "hideCwd", env: "HIDE_CWD", schema: z.boolean() },
  { path: "extensions.enabled", target: "extensionsEnabled", env: "EXTENSIONS", schema: z.boolean() },
  { path: "memory.auto_save", target: "memoryAutoSave", env: "MEMORY_AUTO_SAVE", schema: z.boolean() },
  { path: "goals.auto_accept_criteria", target: "autoAcceptCriteria", env: "GOAL_AUTO_ACCEPT_CRITERIA", schema: z.boolean() },
  { path: "threads.relative_time", target: "threadRelativeTime", schema: z.boolean() },
  { path: "threads.sort_order", target: "threadSortOrder", schema: z.enum(["updated_at", "created_at"]) },
  { path: "warnings.session_cost_threshold_usd", target: "sessionCostWarningUsd", schema: z.number().finite() },
  { path: "update.auto_update", target: "autoUpdate", env: "AUTO_UPDATE", schema: z.boolean() },
  { path: "update.check", target: "updateCheck", schema: z.boolean() },
  { target: "updateCheck", env: "NO_UPDATE_CHECK", schema: z.boolean(), presence: true, invert: true },
  { target: "offline", env: "OFFLINE", schema: z.boolean() },
];

function apply(option: Option, raw: unknown, values: Record<string, unknown>, diagnostics: string[], source: string) {
  const parsed = option.schema.safeParse(raw);
  if (!parsed.success) { diagnostics.push(`Invalid ${source} value for ${option.path ?? option.target}; falling back to the next configuration layer`); return; }
  const value = option.invert ? !parsed.data : parsed.data;
  if (option.target === "selection") {
    if (!Object.hasOwn(values, "model")) Object.assign(values, value);
  } else if (!Object.hasOwn(values, option.target)) values[option.target] = value;
}

export function parseUpstreamConfiguration(text: string, diagnostics: string[] = []) {
  const config = parse(text);
  const paths = new Set(COMPATIBILITY_OPTIONS.flatMap((entry) => entry.path ? [entry.path] : []));
  paths.add("models.providers");
  const flat: Record<string, unknown> = {};
  const walk = (value: Record<string, unknown>, prefix = "") => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (paths.has(path)) flat[path] = child;
      else if ([...paths].some((known) => known.startsWith(`${path}.`)) && child && typeof child === "object" && !Array.isArray(child)) walk(child as Record<string, unknown>, path);
      else throw new Error(`Unsupported upstream setting: ${path}. Its runtime behavior has not been ported; it was not silently accepted.`);
    }
  };
  walk(config);
  const settings: Record<string, unknown> = {};
  for (const option of COMPATIBILITY_OPTIONS) if (option.path && Object.hasOwn(flat, option.path)) apply(option, flat[option.path], settings, diagnostics, "TOML");
  const providers = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), provider).parse(flat["models.providers"] ?? {});
  return { version: 1 as const, settings, providers: Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, { endpoint: value.base_url, ...(value.api_key_env ? { apiKeyEnv: value.api_key_env } : {}), models: value.models ?? [] }])) };
}

export async function readUpstreamConfiguration(path: string, diagnostics: string[] = []): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error("TOML configuration exceeds 1 MB");
    return parseUpstreamConfiguration(await file.readFile("utf8"), diagnostics);
  } finally { await file.close(); }
}

export function upstreamEnvironment(env: NodeJS.ProcessEnv, diagnostics: string[] = []): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const option of COMPATIBILITY_OPTIONS) {
    if (!option.env) continue;
    const raw = env[`DEEPAGENTS_CODE_${option.env}`];
    if (raw === undefined) continue;
    let value: unknown = raw;
    if (option.presence) value = raw.length > 0;
    else if (option.schema instanceof z.ZodBoolean) {
      if (/^(1|true|yes|on)$/iu.test(raw.trim())) value = true;
      else if (/^(0|false|no|off)$/iu.test(raw.trim())) value = false;
    } else if (option.schema instanceof z.ZodNumber) value = raw.trim() ? Number(raw) : Number.NaN;
    apply(option, value, values, diagnostics, "environment");
  }
  return values;
}
