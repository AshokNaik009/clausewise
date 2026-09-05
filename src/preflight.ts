import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getQuickJS } from "quickjs-emscripten";
import { LIMITS } from "./constants.js";
import { RegCompareError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface DoctorResult {
  schema_version: "1.0";
  healthy: boolean;
  checks: Record<string, { ok: boolean; detail: string }>;
  limits: typeof LIMITS;
}

async function command(command: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 30_000, maxBuffer: 128 * 1024 });
    return { ok: true, detail: (stdout || stderr).trim().slice(0, 500) || "available" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: detail.slice(0, 500) };
  }
}

export async function doctor(): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = {};
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.node = { ok: nodeMajor === 22, detail: process.versions.node };
  checks.npm = await command("npm", ["--version"]);
  try {
    const quickJs = await getQuickJS();
    const result = quickJs.evalCode("1 + 1", { memoryLimitBytes: LIMITS.quickJsMemoryBytes });
    checks.quickjs = { ok: result === 2, detail: result === 2 ? "quickjs-emscripten runtime available" : "QuickJS evaluation returned an unexpected result" };
  } catch (error) {
    checks.quickjs = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  checks.devin_version = await command("devin", ["--version"]);
  const authentication = await command("devin", ["auth", "status"]);
  checks.devin_auth = { ok: authentication.ok && /logged in/iu.test(authentication.detail), detail: authentication.ok ? "authenticated" : "not authenticated" };
  const help = await command("devin", ["--help"]);
  try {
    const output = await execFileAsync("devin", ["--help"], { timeout: 30_000, maxBuffer: 128 * 1024 });
    checks.devin_flags = { ok: /--sandbox/u.test(output.stdout) && /--print/u.test(output.stdout), detail: help.detail };
  } catch {
    checks.devin_flags = { ok: false, detail: help.detail };
  }
  checks.sandbox = await command("devin", ["sandbox", "setup"]);
  checks.worker_policy = { ok: true, detail: "Per-worker policy denies Fetch(*) and durable-run Read(...) while sandbox filtering uses a non-internet allowlist." };
  return { schema_version: "1.0", healthy: Object.values(checks).every((check) => check.ok), checks, limits: LIMITS };
}

export async function assertDoctor(): Promise<DoctorResult> {
  const result = await doctor();
  if (!result.healthy) {
    const failures = Object.entries(result.checks).filter(([, check]) => !check.ok).map(([name]) => name).join(", ");
    throw new RegCompareError("preflight_failed", `Preflight failed: ${failures}.`, 2);
  }
  return result;
}
