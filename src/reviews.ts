import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { RegCompareError } from "./errors.js";
import { reviewRecordSchema, type ApprovedPlan, type Finding, type ReviewRecord } from "./schemas.js";
import type { Workspace } from "./workspace.js";
import { appendEvent, artifactPath, recordArtifact, writeImmutableJson } from "./workspace.js";

export interface ReviewInput {
  autoApprove: boolean;
  plan?: ApprovedPlan;
  findings?: Finding[];
  partial?: boolean;
  round: number;
}

export function createReviewRecord(stage: ReviewRecord["stage"], round: number, mode: ReviewRecord["mode"], decision: ReviewRecord["decision"], amendment: string | null, dispositions: ReviewRecord["dispositions"]): ReviewRecord {
  return reviewRecordSchema.parse({
    schema_version: "1.0",
    review_id: randomUUID(),
    stage,
    round,
    mode,
    actor: mode === "automation" ? "automation" : "local-user",
    decision,
    amendment,
    dispositions,
    timestamp: new Date().toISOString(),
  });
}

async function prompt(question: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return (await reader.question(question)).trim();
  } finally {
    reader.close();
  }
}

export async function collectReview(input: ReviewInput): Promise<ReviewRecord> {
  const stage: ReviewRecord["stage"] = input.partial ? "partial" : input.plan ? "plan" : "final";
  if (input.autoApprove) {
    if (stage === "partial") throw new RegCompareError("partial_requires_interactive_confirmation", "A partial result requires explicit interactive confirmation.", 5);
    const dispositions = (input.findings ?? []).filter((finding) => finding.materiality === "critical" || finding.materiality === "high").map((finding) => ({ finding_id: finding.id, value: "accepted" as const }));
    return createReviewRecord(stage, input.round, "automation", "approved", null, dispositions);
  }
  if (stage === "plan") {
    const themes = input.plan?.themes.map((theme) => `${theme.theme_id}: ${theme.label}`).join("; ") ?? "";
    const response = await prompt(`Review plan (${themes}). Enter approve, reject, or amend <text>: `);
    if (response === "approve") return createReviewRecord("plan", input.round, "interactive", "approved", null, []);
    if (response === "reject") return createReviewRecord("plan", input.round, "interactive", "rejected", null, []);
    if (response.startsWith("amend ") && response.slice(6).trim()) return createReviewRecord("plan", input.round, "interactive", "amended", response.slice(6).trim(), []);
    throw new RegCompareError("invalid_review_response", "Plan review must be approve, reject, or amend <text>.", 5);
  }
  if (stage === "partial") {
    const response = await prompt("Partial results exclude one or more themes. Enter confirm-partial to finalize, or reject: ");
    if (response === "confirm-partial") return createReviewRecord("partial", input.round, "interactive", "confirmed_partial", null, []);
    if (response === "reject") return createReviewRecord("partial", input.round, "interactive", "rejected", null, []);
    throw new RegCompareError("invalid_review_response", "Partial review must be confirm-partial or reject.", 5);
  }
  const required = (input.findings ?? []).filter((finding) => finding.materiality === "critical" || finding.materiality === "high");
  const dispositions: ReviewRecord["dispositions"] = [];
  for (const finding of required) {
    const response = await prompt(`Disposition ${finding.id} (${finding.title}): accepted, deferred, rejected, or needs_evidence: `);
    if (!["accepted", "deferred", "rejected", "needs_evidence"].includes(response)) throw new RegCompareError("invalid_review_response", `Invalid disposition for ${finding.id}.`, 5);
    dispositions.push({ finding_id: finding.id, value: response as "accepted" | "deferred" | "rejected" | "needs_evidence" });
  }
  const response = await prompt("Enter approve or reject finalization: ");
  if (response === "reject") return createReviewRecord("final", input.round, "interactive", "rejected", null, dispositions);
  if (response !== "approve") throw new RegCompareError("invalid_review_response", "Final review must be approve or reject.", 5);
  return createReviewRecord("final", input.round, "interactive", "approved", null, dispositions);
}

export async function saveReview(workspace: Workspace, review: ReviewRecord): Promise<string> {
  const filename = review.stage === "partial" ? `partial-${review.round}.json` : `${review.stage}-${review.round}.json`;
  const artifact = `reviews/${filename}`;
  await writeImmutableJson(artifactPath(workspace, artifact), review);
  await recordArtifact(workspace, artifact);
  await appendEvent(workspace, "review_recorded", "reviewer", { artifact, stage: review.stage, decision: review.decision });
  return artifact;
}

export function ensureFinalReview(review: ReviewRecord, findings: Finding[]): void {
  if (review.stage !== "final" || review.decision !== "approved") throw new RegCompareError("final_review_rejected", "Final review did not approve publication.", 5);
  const expected = new Set(findings.filter((finding) => finding.materiality === "critical" || finding.materiality === "high").map((finding) => finding.id));
  const dispositions = new Map(review.dispositions.map((disposition) => [disposition.finding_id, disposition.value]));
  for (const findingId of expected) {
    if (!dispositions.has(findingId)) throw new RegCompareError("missing_final_disposition", `Critical/high finding ${findingId} lacks a reviewer disposition.`, 5);
  }
}
