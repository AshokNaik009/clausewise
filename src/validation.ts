import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RegCompareError } from "./errors.js";
import { analysisSchema, approvedPlanSchema, normalizedDocumentSchema, reviewRecordSchema, themeResultSchema, type Analysis, type NormalizedDocument } from "./schemas.js";
import { policyGapDisclaimerText, renderReport } from "./report.js";
import type { Workspace } from "./workspace.js";
import { artifactPath, getManifest, getState, readJson, validateLedger } from "./workspace.js";
import { verifyCitation } from "./citations.js";

export interface ValidationResult {
  schema_version: "1.0";
  valid: boolean;
  run_id: string;
  state: string;
  errors: string[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function checkJsonArtifacts(workspace: Workspace, errors: string[]): Promise<void> {
  const checks: { directory: string; pattern: RegExp; parse: (value: unknown) => unknown }[] = [
    { directory: "sources/normalized", pattern: /\.json$/u, parse: (value) => normalizedDocumentSchema.parse(value) },
    { directory: "planning", pattern: /^plan-\d+\.json$/u, parse: (value) => approvedPlanSchema.parse(value) },
    { directory: "reviews", pattern: /^(plan|final|partial)-\d+\.json$/u, parse: (value) => reviewRecordSchema.parse(value) },
    { directory: "workers", pattern: /\.json$/u, parse: (value) => value },
  ];
  for (const check of checks) {
    const directory = artifactPath(workspace, check.directory);
    const visit = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (check.pattern.test(entry.name)) {
          try {
            check.parse(await readJson(child));
          } catch (error) {
            errors.push(`${child}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    };
    try {
      await visit(directory);
    } catch (error) {
      errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function verifyEventMirror(workspace: Workspace, errors: string[]): Promise<void> {
  try {
    const entries = (await readdir(artifactPath(workspace, "events"))).filter((entry) => entry.endsWith(".json")).sort();
    const expected = await Promise.all(entries.map(async (entry) => `${JSON.stringify(await readJson(join(artifactPath(workspace, "events"), entry)))}\n`));
    const actual = await readFile(artifactPath(workspace, "logs/events.ndjson"), "utf8");
    if (actual !== expected.join("")) errors.push("logs/events.ndjson is not a byte-for-byte mirror of the event ledger.");
  } catch (error) {
    errors.push(`Event mirror: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function citationsValid(analysis: Analysis, documents: Map<string, NormalizedDocument>, errors: string[]): void {
  for (const theme of analysis.themes) {
    for (const finding of theme.findings) {
      for (const citation of finding.evidence) {
        const verified = verifyCitation(documents, citation);
        if ("code" in verified || !citation.verified || ("excerpt_sha256" in verified && verified.excerpt_sha256 !== citation.excerpt_sha256)) {
          errors.push(`${finding.id}: an evidence citation is invalid.`);
        }
      }
      if ((finding.materiality === "critical" || finding.materiality === "high") && !finding.action_candidate) errors.push(`${finding.id}: critical/high finding lacks an action candidate.`);
      if (finding.materiality === "no_material_change" && (finding.action_candidate || new Set(finding.evidence.map((citation) => citation.document_id)).size !== 2)) errors.push(`${finding.id}: no-material-change finding lacks required scope evidence.`);
    }
  }
}

export async function validateRun(workspace: Workspace): Promise<ValidationResult> {
  const errors: string[] = [];
  let state = "unknown";
  try {
    state = (await validateLedger(workspace)).state;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  await checkJsonArtifacts(workspace, errors);
  await verifyEventMirror(workspace, errors);
  try {
    const current = await getState(workspace);
    if (current.state === "finalized") {
      const manifest = await getManifest(workspace);
      const analysis = analysisSchema.parse(await readJson(artifactPath(workspace, "analysis.json")));
      const rendered = renderReport(analysis, manifest.data_classification);
      const report = await readFile(artifactPath(workspace, "report.md"), "utf8");
      if (rendered !== report) errors.push("report.md differs from the deterministic rendering of analysis.json.");
      if (hash(report) !== analysis.rendered_report_sha256) errors.push("analysis.json report hash does not match report.md.");
      if (analysis.profile === "policy-gap") {
        const disclaimer = `> ${policyGapDisclaimerText()}`;
        const disclaimerIndex = report.indexOf(disclaimer);
        const summaryIndex = report.indexOf("## Executive summary");
        if (disclaimerIndex < 0 || summaryIndex < 0 || disclaimerIndex > summaryIndex || report.slice(disclaimerIndex + disclaimer.length, summaryIndex).trim() !== "") errors.push("policy-gap disclaimer is absent or not immediately after title and metadata.");
      }
      const documents = new Map<string, NormalizedDocument>();
      for (const id of ["baseline", "candidate"] as const) documents.set(id, normalizedDocumentSchema.parse(await readJson(artifactPath(workspace, `sources/normalized/${id}.json`))));
      citationsValid(analysis, documents, errors);
      if (analysis.completion_status === "complete" && analysis.excluded_themes.length) errors.push("Complete analysis has excluded themes.");
      if (analysis.completion_status === "partial" && !analysis.excluded_themes.length) errors.push("Partial analysis has no excluded themes.");
    } else {
      for (const output of ["analysis.json", "report.md"]) {
        try {
          await readFile(artifactPath(workspace, output));
          errors.push(`${output} exists before finalization.`);
        } catch {
          continue;
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { schema_version: "1.0", valid: errors.length === 0, run_id: workspace.runId, state, errors };
}

export async function assertValidRun(workspace: Workspace): Promise<ValidationResult> {
  const result = await validateRun(workspace);
  if (!result.valid) throw new RegCompareError("validation_failed", result.errors.join(" "), 3);
  return result;
}

export async function inspectRun(workspace: Workspace): Promise<Record<string, unknown>> {
  const [manifest, state] = await Promise.all([getManifest(workspace), getState(workspace)]);
  return {
    schema_version: "1.0",
    run_id: workspace.runId,
    profile: manifest.profile,
    data_classification: manifest.data_classification,
    state: state.state,
    active_plan_path: state.active_plan_path,
    active_review_stage: state.active_review_stage,
    used_agent_calls: state.used_agent_calls,
    remaining_agent_calls: state.remaining_agent_calls,
    worker_statuses: state.worker_statuses,
    final_artifact_paths: state.final_artifact_paths,
  };
}
