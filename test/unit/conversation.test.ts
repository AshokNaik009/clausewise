import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeSemanticDelegate = vi.hoisted(() => vi.fn());
vi.mock("../../src/agents.js", () => ({ invokeSemanticDelegate }));

import { finalizeConversationRun, submitConversationPlan } from "../../src/orchestrator.js";
import { artifactPath, createWorkspace, getState, reserveModelCall, transitionState, validateLedger, writeImmutableFile, writeImmutableJson } from "../../src/workspace.js";
import { validateRun } from "../../src/validation.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  invokeSemanticDelegate.mockReset();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const recordId = (documentId: "baseline" | "candidate") => `${documentId}:p0001:l000001`;

function document(documentId: "baseline" | "candidate") {
  const text = `${documentId} obligation`;
  return {
    schema_version: "1.0" as const,
    canonicalization_version: "canon-v1" as const,
    document_id: documentId,
    format: "text" as const,
    records: [{
      record_id: recordId(documentId),
      ordinal: 1,
      page: 1,
      page_line: 1,
      global_line: 1,
      heading: null,
      raw_text: text,
      canonical_text: text,
      source_order: { page: 1, page_line: 1 },
    }],
  };
}

function approvedPlan() {
  return {
    schema_version: "1.0" as const,
    plan_id: randomUUID(),
    round: 1,
    mapper_artifact_path: "planning/mapper-result-1.json",
    themes: [{
      theme_id: "thm-001-customer-due-diligence",
      label: "Customer due diligence",
      description: "Compare customer-identification obligations.",
      keywords: ["customer", "due diligence"],
      seed_record_ids: [recordId("baseline"), recordId("candidate")],
      context_packet_path: "context/thm-001/packet.json",
    }],
    limits: { max_themes: 1, theme_context_chars: 100_000 as const, theme_context_records: 80 as const },
    call_budget: { used: 0, remaining: 2, maximum_remaining: 2 },
    payload_sha256: "0".repeat(64),
  };
}

function progress(planRound: number) {
  const finding = {
    id: "F-0001",
    theme_id: "thm-001-customer-due-diligence",
    title: "Customer identification changed",
    summary: "The candidate changes the customer-identification obligation.",
    materiality: "high" as const,
    materiality_rationale: "The obligation affects onboarding controls.",
    confidence: "high" as const,
    evidence: [{
      document_id: "baseline" as const,
      start_record_id: recordId("baseline"),
      end_record_id: recordId("baseline"),
      excerpt: "baseline obligation",
      page_start: 1,
      page_end: 1,
      global_line_start: 1,
      global_line_end: 1,
      heading_start: null,
      heading_end: null,
      excerpt_sha256: "0".repeat(64),
      verified: true as const,
    }],
    action_candidate: { description: "Assess onboarding controls.", action_type: "assess" as const, review_disposition: "not_required" as const },
    profile_assessment: { change_type: "modified", effective_or_publication_context: "Test context." },
  };
  return {
    schema_version: "1.0" as const,
    plan_round: planRound,
    themes: [{
      theme_id: "thm-001-customer-due-diligence",
      label: "Customer due diligence",
      status: "complete" as const,
      outcome: "assessed" as const,
      outcome_rationale: "The change is assessable.",
      attempt_artifacts: ["workers/thm-001/attempt-1.json"],
      context_packet_path: "context/thm-001/packet.json",
      findings: [finding],
      rejected_finding_references: [],
      coverage: { included_records: 2, candidate_records: 2, context_truncated: false },
    }],
    excluded_themes: [],
    mapper_body_sample_ratio: 1,
  };
}

async function workspace(state: "awaiting_plan_review" | "awaiting_final_review") {
  const parent = await mkdtemp(join(tmpdir(), "reg-compare-conversation-test-"));
  temporaryPaths.push(parent);
  const documents = ["baseline", "candidate"].map((documentId) => ({
    document_id: documentId,
    display_name: `${documentId}.txt`,
    format: "text",
    language: "en",
    raw_artifact_path: `sources/raw/${documentId}.txt`,
    normalized_artifact_path: `sources/normalized/${documentId}.json`,
    sha256: "0".repeat(64),
    page_count: 1,
    record_count: 1,
    canonicalization_version: "canon-v1",
  }));
  const run = await createWorkspace(join(parent, "run"), {
    profile: "version-change",
    data_classification: "public",
    options: {
      profile: "version-change",
      dataClassification: "public",
      maxThemes: 1,
      concurrency: 1,
      agentCallBudget: 2,
      agentTimeoutSeconds: 30,
      maxSourcePages: 1,
      maxSourceChars: 10_000,
      allowPartial: false,
      autoApprove: false,
      confirmExternalModelAccess: false,
      confirmEncryptedWorkspace: false,
      retentionUntil: null,
    },
    model: { model: "deepseek/deepseek-chat", base_url: "https://openrouter.ai/api/v1", temperature: 0, provider_order: ["approved-provider"], allow_fallbacks: false, data_collection: "deny" },
    documents,
    normalization_version: "canon-v1",
  });
  for (const documentId of ["baseline", "candidate"] as const) {
    await writeImmutableFile(artifactPath(run, `sources/raw/${documentId}.txt`), `${documentId} obligation`);
    await writeImmutableJson(artifactPath(run, `sources/normalized/${documentId}.json`), document(documentId));
  }
  const plan = approvedPlan();
  await writeImmutableJson(artifactPath(run, "planning/plan-1.json"), plan);
  if (state === "awaiting_final_review") await writeImmutableJson(artifactPath(run, "audit/conversation-progress-1.json"), progress(plan.round));
  await transitionState(run, state, { active_plan_path: "planning/plan-1.json", active_review_stage: state === "awaiting_plan_review" ? "plan" : "final" });
  return run;
}

describe("conversational orchestration", () => {
  it("records approved and rejected plan decisions, releasing the run lock between reviewer turns", async () => {
    const approved = await workspace("awaiting_plan_review");
    await expect(submitConversationPlan(approved.root, "approved")).resolves.toMatchObject({ decision: "approved", plan: { round: 1 } });
    await expect(getState(approved)).resolves.toMatchObject({ state: "awaiting_plan_review" });
    await expect(access(artifactPath(approved, "lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(validateLedger(approved)).resolves.toMatchObject({ state: "awaiting_plan_review" });

    const rejected = await workspace("awaiting_plan_review");
    await expect(submitConversationPlan(rejected.root, "rejected")).resolves.toMatchObject({ decision: "rejected", plan: null });
    await expect(getState(rejected)).resolves.toMatchObject({ state: "cancelled" });
    await expect(access(artifactPath(rejected, "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives a new plan after an amendment with a callback-backed model-call reservation", async () => {
    invokeSemanticDelegate.mockImplementation(async (input: { attempt: number; reserveModelCall: () => Promise<void>; workspace: Awaited<ReturnType<typeof workspace>> }) => {
      await input.reserveModelCall();
      const value = {
        schema_version: "1.0",
        proposals: [{
          label: "Customer due diligence",
          description: "Compare customer-identification obligations.",
          keywords: ["customer", "due diligence"],
          ranking_rationale: "The records describe the same regulatory topic.",
          seed_record_ids: [recordId("baseline"), recordId("candidate")],
        }],
      };
      const artifact = `planning/mapper-attempt-${input.attempt}.json`;
      await writeImmutableJson(artifactPath(input.workspace, artifact), {
        schema_version: "1.0",
        role: "mapper",
        theme_id: null,
        command: "deepagents/openrouter",
        timestamps: { completed_at: new Date().toISOString() },
        exit_status: 0,
        signal: null,
        stderr_truncated: false,
        stderr: "",
        stdout: JSON.stringify(value),
        outcome: "ok",
      });
      return { value, process: { stdout: JSON.stringify(value), stderr: "", stderr_truncated: false, exit_code: 0, signal: null, duration_ms: 0, outcome: "ok" }, artifact };
    });
    const run = await workspace("awaiting_plan_review");
    await expect(submitConversationPlan(run.root, "amended", "Focus on onboarding controls.")).resolves.toMatchObject({ decision: "amended", plan: { round: 2 } });
    await expect(validateLedger(run)).resolves.toMatchObject({ state: "awaiting_plan_review", used_agent_calls: 1, remaining_agent_calls: 1 });
    await expect(validateRun(run)).resolves.toMatchObject({ valid: true, state: "awaiting_plan_review" });
    await expect(access(artifactPath(run, "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires critical and high finding dispositions before finalization", async () => {
    const run = await workspace("awaiting_final_review");
    await expect(finalizeConversationRun(run.root, "approved", [])).rejects.toMatchObject({ code: "missing_final_disposition" });
    await expect(getState(run)).resolves.toMatchObject({ state: "awaiting_final_review" });
    await expect(access(artifactPath(run, "lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(validateLedger(run)).resolves.toMatchObject({ state: "awaiting_final_review" });

    await expect(finalizeConversationRun(run.root, "approved", [{ finding_id: "F-0001", value: "accepted" }])).resolves.toMatchObject({ state: "finalized" });
    await expect(validateLedger(run)).resolves.toMatchObject({ state: "finalized" });
  });

  it("never creates more reservations than the analysis model-call budget", async () => {
    const run = await workspace("awaiting_plan_review");
    await expect(Promise.all([
      reserveModelCall(run, "mapper", null),
      reserveModelCall(run, "theme_worker", "thm-001-customer-due-diligence"),
      reserveModelCall(run, "theme_worker", "thm-001-customer-due-diligence"),
    ])).resolves.toEqual([true, true, false]);
    await expect(validateLedger(run)).resolves.toMatchObject({ used_agent_calls: 2, remaining_agent_calls: 0 });
  });
});
