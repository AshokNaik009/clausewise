#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import figlet from "figlet";
import { RegCompareError } from "./errors.js";
import { fetchFixture, verifyFixtures } from "./fixtures.js";
import { runComparison, resumeComparison } from "./orchestrator.js";
import { doctor } from "./preflight.js";
import { invokeQuickJsBridge } from "./quickjs.js";
import { startShell } from "./shell.js";
import { assertWorkspace, appendEvent, releaseLock } from "./workspace.js";
import { inspectRun, validateRun } from "./validation.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let renderedBanner = false;

function banner(): void {
  if (renderedBanner) return;
  renderedBanner = true;
  process.stdout.write(`${figlet.textSync("CLAUSEWISE", { font: "Standard", horizontalLayout: "default" })}\nRegulatory Document Comparison\n\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function show(json: boolean | undefined): void {
  if (!json) banner();
}

function fail(error: unknown): never {
  if (error instanceof RegCompareError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.exitCode;
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`internal_error: ${message}\n`);
  process.exitCode = 1;
  throw error;
}

const program = new Command();
program.name("reg-compare").description("DEEPAGENT HARNESS regulatory document comparison").version("0.1.0");
program.action(async () => {
  banner();
  await startShell();
});

program.command("doctor")
  .option("--json", "emit exactly one JSON object")
  .option("--network", "test the configured model endpoint")
  .action(async (options: { json?: boolean; network?: boolean }) => {
    const result = await doctor(options.network === undefined ? {} : { network: options.network });
    if (options.json) printJson(result);
    else {
      show(false);
      for (const [name, check] of Object.entries(result.checks)) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${name}: ${check.detail}\n`);
      process.stdout.write(`Limits: ${JSON.stringify(result.limits)}\n`);
    }
    if (!result.healthy) process.exitCode = 2;
  });

program.command("run")
  .requiredOption("--profile <profile>", "consultation-impact, version-change, cross-guidance, or policy-gap")
  .requiredOption("--baseline <path>", "baseline .pdf, .md, or .txt source")
  .requiredOption("--candidate <path>", "candidate .pdf, .md, or .txt source")
  .option("--data-classification <classification>", "public, internal, or confidential", "public")
  .option("--output <directory>", "new run directory")
  .option("--max-themes <count>", "maximum themes, 1-6", "6")
  .option("--concurrency <count>", "concurrent workers, 1-3", "2")
  .option("--agent-call-budget <count>", "maximum external analysis model calls, 2-14", "9")
  .option("--agent-timeout-seconds <seconds>", "worker timeout, 30-900", "300")
  .option("--max-source-pages <count>", "maximum PDF pages, 1-350", "350")
  .option("--max-source-chars <count>", "maximum normalized characters per source, 10000-2500000", "2500000")
  .option("--allow-partial", "allow an interactive partial finalization")
  .option("--auto-approve", "record automated review approvals")
  .option("--confirm-external-model-access", "confirm external model access for internal/confidential data")
  .option("--confirm-encrypted-workspace", "confirm confidential output uses an approved encrypted workspace")
  .option("--retention-until <timestamp>", "confidential data retention timestamp, maximum 30 days")
  .option("--dry-run", "normalize sources and calculate capacity without model calls or a durable run directory")
  .action(async (options) => {
    show(false);
    const result = await runComparison(options);
    process.stdout.write(`${result.dry_run ? "Dry-run validated" : "Run finalized"}: ${result.run_directory}\n`);
    if (result.plan) process.stdout.write(`Effective theme cap: ${result.plan.effective_theme_cap}; remaining analysis model calls after mapper: ${result.plan.remaining_agent_calls}\n`);
  });

program.command("resume")
  .requiredOption("--run <directory>", "existing run directory")
  .option("--auto-approve", "record automated review approvals")
  .action(async (options: { run: string; autoApprove?: boolean }) => {
    show(false);
    const result = await resumeComparison(options.run, Boolean(options.autoApprove));
    process.stdout.write(`Run ${result.state}: ${result.run_directory}\n`);
  });

program.command("validate")
  .requiredOption("--run <directory>", "existing run directory")
  .option("--json", "emit exactly one JSON object")
  .action(async (options: { run: string; json?: boolean }) => {
    const workspace = await assertWorkspace(options.run);
    const result = await validateRun(workspace);
    if (options.json) printJson(result);
    else {
      show(false);
      process.stdout.write(`${result.valid ? "VALID" : "INVALID"} ${result.run_id} (${result.state})\n`);
      for (const error of result.errors) process.stdout.write(`- ${error}\n`);
    }
    if (!result.valid) process.exitCode = 3;
  });

program.command("inspect")
  .requiredOption("--run <directory>", "existing run directory")
  .option("--json", "emit exactly one JSON object")
  .action(async (options: { run: string; json?: boolean }) => {
    const result = await inspectRun(await assertWorkspace(options.run));
    if (options.json) printJson(result);
    else {
      show(false);
      for (const [key, value] of Object.entries(result)) process.stdout.write(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    }
  });

const fixtures = program.command("fixtures");
fixtures.command("verify")
  .option("--json", "emit exactly one JSON object")
  .action(async (options: { json?: boolean }) => {
    const result = await verifyFixtures(projectRoot);
    if (options.json) printJson(result);
    else {
      show(false);
      for (const fixture of result.fixtures) process.stdout.write(`${fixture.valid ? "PASS" : "FAIL"} ${fixture.id}: ${fixture.detail}\n`);
    }
    if (!result.valid) process.exitCode = 3;
  });
fixtures.command("fetch")
  .requiredOption("--id <fixture-id>", "fixture ID")
  .option("--confirm-public-download", "confirm the specific public fixture download")
  .action(async (options: { id: string; confirmPublicDownload?: boolean }) => {
    show(false);
    const result = await fetchFixture(projectRoot, options.id, Boolean(options.confirmPublicDownload));
    process.stdout.write(`Fetched ${result.id}: ${result.path}\n`);
  });

program.command("purge")
  .requiredOption("--run <directory>", "existing run directory")
  .option("--confirm-purge", "confirm purge of this exact run")
  .action(async (options: { run: string; confirmPurge?: boolean }) => {
    if (!options.confirmPurge) throw new RegCompareError("purge_confirmation_required", "purge requires --confirm-purge for the specified --run directory.", 1);
    const workspace = await assertWorkspace(options.run);
    await appendEvent(workspace, "purge_intent", "coordinator", { run: workspace.root, confirmed: true });
    await releaseLock(workspace);
    await rm(workspace.root, { recursive: true, force: false });
    show(false);
    process.stdout.write(`Purged ${workspace.root}\n`);
  });

program.command("worker-quickjs")
  .requiredOption("--socket <socket>", "worker QuickJS socket")
  .requiredOption("--capability-file <file>", "single-use capability file")
  .requiredOption("--script <file>", "QuickJS source file")
  .option("--caller-role <role>", "theme_worker or evidence_audit", "theme_worker")
  .option("--read <path...>", "declared allowed reads")
  .option("--write <path...>", "declared allowed writes")
  .action(async (options: { socket: string; capabilityFile: string; script: string; callerRole: "theme_worker" | "evidence_audit"; read?: string[]; write?: string[] }) => {
    if (!["theme_worker", "evidence_audit"].includes(options.callerRole)) throw new RegCompareError("quickjs_caller_role", "--caller-role must be theme_worker or evidence_audit.", 1);
    printJson(await invokeQuickJsBridge(options.socket, options.capabilityFile, options.callerRole, options.script, options.read ?? [], options.write ?? []));
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof RegCompareError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`internal_error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
