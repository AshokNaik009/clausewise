import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { LIMITS } from "./constants.js";
import { RegCompareError, assert } from "./errors.js";
import { classificationSchema, profileSchema, type Classification, type Profile } from "./schemas.js";
import type { RunOptions } from "./workspace.js";

export interface RunInput extends RunOptions {
  baseline: string;
  candidate: string;
  output: string;
  dryRun: boolean;
}

export interface RawRunInput {
  profile: string;
  baseline: string;
  candidate: string;
  dataClassification?: string;
  output?: string;
  maxThemes?: string | number;
  concurrency?: string | number;
  agentCallBudget?: string | number;
  agentTimeoutSeconds?: string | number;
  maxSourcePages?: string | number;
  maxSourceChars?: string | number;
  allowPartial?: boolean;
  autoApprove?: boolean;
  confirmExternalModelAccess?: boolean;
  confirmEncryptedWorkspace?: boolean;
  retentionUntil?: string;
  dryRun?: boolean;
}

function integer(value: string | number | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RegCompareError("invalid_limit", `${name} must be an integer from ${minimum} to ${maximum}.`, 1);
  }
  return parsed;
}

function defaultOutput(profile: Profile): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return resolve("runs", `${timestamp}-${profile}`);
}

function validateRetention(value: string | undefined, classification: Classification): string | null {
  if (classification !== "confidential") {
    if (value) throw new RegCompareError("retention_not_applicable", "--retention-until is permitted only with confidential data.", 1);
    return null;
  }
  if (!value) throw new RegCompareError("retention_required", "Confidential data requires --retention-until.", 2);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.valueOf() <= Date.now() || parsed.valueOf() > Date.now() + LIMITS.maxConfidentialRetentionDays * 86_400_000) {
    throw new RegCompareError("invalid_retention", "--retention-until must be an ISO-8601 timestamp within 30 days in the future.", 2);
  }
  return parsed.toISOString();
}

export function parseRunInput(raw: RawRunInput): RunInput {
  const profile = profileSchema.safeParse(raw.profile);
  if (!profile.success) throw new RegCompareError("invalid_profile", "--profile must be consultation-impact, version-change, cross-guidance, or policy-gap.", 1);
  const classification = classificationSchema.safeParse(raw.dataClassification ?? "public");
  if (!classification.success) throw new RegCompareError("invalid_classification", "--data-classification must be public, internal, or confidential.", 1);
  const maxThemes = integer(raw.maxThemes, LIMITS.defaultMaxThemes, "--max-themes", 1, LIMITS.maxThemes);
  const concurrency = integer(raw.concurrency, LIMITS.defaultConcurrency, "--concurrency", LIMITS.minConcurrency, LIMITS.maxConcurrency);
  const agentCallBudget = integer(raw.agentCallBudget, LIMITS.defaultAgentCallBudget, "--agent-call-budget", LIMITS.minAgentCallBudget, LIMITS.maxAgentCallBudget);
  const agentTimeoutSeconds = integer(raw.agentTimeoutSeconds, LIMITS.defaultAgentTimeoutSeconds, "--agent-timeout-seconds", LIMITS.minAgentTimeoutSeconds, LIMITS.maxAgentTimeoutSeconds);
  const maxSourcePages = integer(raw.maxSourcePages, LIMITS.defaultMaxSourcePages, "--max-source-pages", LIMITS.minSourcePages, LIMITS.maxSourcePages);
  const maxSourceChars = integer(raw.maxSourceChars, LIMITS.defaultMaxSourceChars, "--max-source-chars", LIMITS.minSourceChars, LIMITS.maxSourceChars);
  const allowPartial = Boolean(raw.allowPartial);
  const autoApprove = Boolean(raw.autoApprove);
  if (allowPartial && autoApprove) throw new RegCompareError("invalid_approval_mode", "--auto-approve cannot be combined with --allow-partial.", 1);
  const confirmExternalModelAccess = Boolean(raw.confirmExternalModelAccess);
  const confirmEncryptedWorkspace = Boolean(raw.confirmEncryptedWorkspace);
  if (classification.data !== "public" && !confirmExternalModelAccess) throw new RegCompareError("external_model_confirmation_required", "Internal and confidential data require --confirm-external-model-access.", 2);
  if (classification.data === "confidential" && !confirmEncryptedWorkspace) throw new RegCompareError("encrypted_workspace_confirmation_required", "Confidential data requires --confirm-encrypted-workspace.", 2);
  const retentionUntil = validateRetention(raw.retentionUntil, classification.data);
  const baseline = resolve(raw.baseline);
  const candidate = resolve(raw.candidate);
  const output = raw.output ? resolve(raw.output) : defaultOutput(profile.data);
  if (baseline === candidate) throw new RegCompareError("duplicate_sources", "--baseline and --candidate must be distinct regular files.", 1);
  if (output === baseline || output === candidate || output === dirname(baseline) || output === dirname(candidate)) throw new RegCompareError("invalid_output", "--output must be a new directory distinct from source paths and source directories.", 1);
  return {
    profile: profile.data,
    baseline,
    candidate,
    output,
    dataClassification: classification.data,
    maxThemes,
    concurrency,
    agentCallBudget,
    agentTimeoutSeconds,
    maxSourcePages,
    maxSourceChars,
    allowPartial,
    autoApprove,
    confirmExternalModelAccess,
    confirmEncryptedWorkspace,
    retentionUntil,
    dryRun: Boolean(raw.dryRun),
  };
}

export async function validateSourceInputs(input: RunInput): Promise<void> {
  const supported = new Set([".pdf", ".md", ".txt"]);
  for (const source of [input.baseline, input.candidate]) {
    const details = await lstat(source).catch(() => null);
    assert(details?.isFile() && !details.isSymbolicLink(), "invalid_source", `Source must be a distinct regular file: ${source}`, 1);
    if (!supported.has(extname(source).toLocaleLowerCase("en"))) throw new RegCompareError("unsupported_format", `Unsupported source format: ${extname(source) || "no extension"}`, 1);
  }
  const [baseline, candidate] = await Promise.all([realpath(input.baseline), realpath(input.candidate)]);
  if (baseline === candidate) throw new RegCompareError("duplicate_sources", "--baseline and --candidate must resolve to distinct regular files.", 1);
}

export function runOptions(input: RunInput): RunOptions {
  const { baseline: _baseline, candidate: _candidate, output: _output, dryRun: _dryRun, ...options } = input;
  return options;
}
