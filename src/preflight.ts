import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getQuickJS } from "quickjs-emscripten";
import { LIMITS } from "./constants.js";
import { modelConfiguration } from "./model.js";
import { RegCompareError } from "./errors.js";

const execFileAsync = promisify(execFile);

interface DoctorCheck {
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface DoctorResult {
  schema_version: "1.0";
  healthy: boolean;
  checks: Record<string, DoctorCheck>;
  limits: typeof LIMITS;
}

async function command(command: string, args: string[]): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 30_000, maxBuffer: 128 * 1024 });
    return { ok: true, detail: (stdout || stderr).trim().slice(0, 500) || "available", required: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: detail.slice(0, 500), required: true };
  }
}

export async function doctor(options: { network?: boolean } = {}): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = {};
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.node = { ok: nodeMajor === 22, detail: process.versions.node, required: true };
  checks.npm = await command("npm", ["--version"]);
  try {
    const quickJs = await getQuickJS();
    const result = quickJs.evalCode("1 + 1", { memoryLimitBytes: LIMITS.quickJsMemoryBytes });
    checks.quickjs = { ok: result === 2, detail: result === 2 ? "quickjs-emscripten runtime available" : "QuickJS evaluation returned an unexpected result", required: true };
  } catch (error) {
    checks.quickjs = { ok: false, detail: error instanceof Error ? error.message : String(error), required: true };
  }
  checks.openrouter_key = { ok: Boolean(process.env.REG_COMPARE_API_KEY ?? process.env.OPENROUTER_API_KEY), detail: process.env.REG_COMPARE_API_KEY || process.env.OPENROUTER_API_KEY ? "configured" : "not configured", required: false };
  try {
    const configuration = modelConfiguration();
    checks.model_configuration = { ok: true, detail: `${configuration.model} via ${configuration.base_url}; provider order: ${configuration.provider_order.join(", ")}`, required: false };
  } catch (error) {
    checks.model_configuration = { ok: false, detail: error instanceof Error ? error.message : String(error), required: false };
  }
  if (options.network) {
    if (!checks.openrouter_key.ok || !checks.model_configuration.ok) {
      checks.openrouter_reachable = { ok: false, detail: "not checked because model credentials or provider routing are not configured", required: true };
    } else {
      try {
        const configuration = modelConfiguration();
        const response = await fetch(`${configuration.base_url.replace(/\/$/u, "")}/models`, {
          headers: { Authorization: `Bearer ${process.env.REG_COMPARE_API_KEY ?? process.env.OPENROUTER_API_KEY}` },
          signal: AbortSignal.timeout(10_000),
        });
        checks.openrouter_reachable = { ok: response.ok, detail: response.ok ? "models endpoint reachable" : `models endpoint returned HTTP ${response.status}`, required: true };
      } catch (error) {
        checks.openrouter_reachable = { ok: false, detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), required: true };
      }
    }
  } else {
    checks.openrouter_reachable = { ok: true, detail: "not checked; run doctor --network to test the configured endpoint", required: false };
  }
  return { schema_version: "1.0", healthy: Object.values(checks).every((check) => !check.required || check.ok), checks, limits: LIMITS };
}

export async function assertDoctor(): Promise<DoctorResult> {
  const result = await doctor();
  if (!result.healthy) {
    const failures = Object.entries(result.checks).filter(([, check]) => check.required && !check.ok).map(([name]) => name).join(", ");
    throw new RegCompareError("preflight_failed", `Preflight failed: ${failures}.`, 2);
  }
  return result;
}
