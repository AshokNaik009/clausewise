import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { auditThemeResult, applyFindingIds, type AuditResult } from "./audit.js";
import { invokeSemanticDelegate } from "./agents.js";
import { buildMapperPacket, buildThemePacket, type ThemePacket } from "./context.js";
import { RegCompareError } from "./errors.js";
import { ingestDocument, type IngestedDocument } from "./ingestion.js";
import { canonicalizeExcerpt, sha256 } from "./normalization.js";
import { parseRunInput, runOptions, validateSourceInputs, type RawRunInput, type RunInput } from "./options.js";
import { assertDoctor } from "./preflight.js";
import { renderReport, reportHash } from "./report.js";
import { collectReview, createReviewRecord, ensureFinalReview, saveReview } from "./reviews.js";
import { analysisSchema, approvedPlanSchema, conversationProgressSchema, mapperProposalSchema, normalizedDocumentSchema, reviewRecordSchema, themeResultSchema, type Analysis, type ApprovedPlan, type ConversationProgress, type Finding, type MapperProposal, type NormalizedDocument, type Profile, type ThemeResult } from "./schemas.js";
import { artifactPath, acquireLock, appendEvent, appendOperationalLog, assertWorkspace, createWorkspace, getManifest, getState, readEvent, readJson, recordArtifact, releaseLock, transitionState, validateLedger, writeImmutableFile, writeImmutableJson, type Workspace } from "./workspace.js";

interface PlanThemeSeed {
  label: string;
  description: string;
  keywords: string[];
  seed_record_ids: string[];
}

interface RawThemeAttempt {
  attempt: number;
  artifact: string | null;
  result: unknown;
  error: string | null;
}

interface PendingTheme {
  theme: ApprovedPlan["themes"][number];
  packet: ThemePacket;
  attempts: RawThemeAttempt[];
}

interface CompletedTheme {
  theme: ApprovedPlan["themes"][number];
  packet: ThemePacket;
  audited: AuditResult;
  raw: { outcome: "assessed" | "no_material_change" | "not_assessable"; outcome_rationale: string };
  attemptArtifacts: string[];
}

export interface RunResult {
  run_directory: string;
  run_id: string | null;
  state: string;
  dry_run: boolean;
  plan?: { effective_theme_cap: number; remaining_agent_calls: number; source_stats: unknown[] };
}

function slug(value: string): string {
  const compact = canonicalizeExcerpt(value).toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return compact.split("-").filter(Boolean).slice(0, 9).join("-") || "theme";
}

function themeId(index: number, label: string): string {
  return `thm-${String(index).padStart(3, "0")}-${slug(label)}`;
}

function safeMapperProposals(proposal: MapperProposal, documents: NormalizedDocument[]): PlanThemeSeed[] {
  const validRecords = new Set(documents.flatMap((document) => document.records.map((record) => record.record_id)));
  const deduplicated = new Set<string>();
  const themes: PlanThemeSeed[] = [];
  for (const candidate of proposal.proposals) {
    const key = canonicalizeExcerpt(candidate.label).toLocaleLowerCase("en");
    const seeds = [...new Set(candidate.seed_record_ids)].filter((recordId) => validRecords.has(recordId));
    if (!key || deduplicated.has(key) || !seeds.length) continue;
    deduplicated.add(key);
    themes.push({ label: candidate.label, description: candidate.description, keywords: [...new Set(candidate.keywords)], seed_record_ids: seeds });
  }
  return themes;
}

export function deriveApprovedPlan(profile: Profile, proposalValue: unknown, documents: NormalizedDocument[], round: number, mapperArtifactPath: string, options: RunInput, usedCalls: number): { plan: ApprovedPlan; packets: Map<string, ThemePacket> } {
  const proposal = mapperProposalSchema.parse(proposalValue);
  const remaining = options.agentCallBudget - usedCalls;
  const effectiveCap = Math.min(options.maxThemes, remaining);
  const seeds = safeMapperProposals(proposal, documents).slice(0, effectiveCap);
  if (!seeds.length) throw new RegCompareError("no_valid_themes", "Mapper returned no valid themes within the available theme and call budgets.", 5);
  const packets = new Map<string, ThemePacket>();
  const themes = seeds.map((seed, index) => {
    const id = themeId(index + 1, seed.label);
    const packet = buildThemePacket({ theme_id: id, ...seed }, documents);
    packets.set(id, packet);
    return { theme_id: id, ...seed, context_packet_path: `context/${id.match(/^thm-\d{3}/u)?.[0] ?? "thm-000"}/packet.json` };
  });
  const provisional = {
    schema_version: "1.0" as const,
    plan_id: randomUUID(),
    round,
    mapper_artifact_path: mapperArtifactPath,
    themes,
    limits: { max_themes: options.maxThemes, theme_context_chars: 100_000 as const, theme_context_records: 80 as const },
    call_budget: { used: usedCalls, remaining, maximum_remaining: remaining },
  };
  return { plan: approvedPlanSchema.parse({ ...provisional, payload_sha256: sha256(JSON.stringify(provisional)) }), packets };
}

function sourceStats(documents: IngestedDocument[]): unknown[] {
  return documents.map((document) => document.sourceStats);
}

function containsInjectionSignals(documents: NormalizedDocument[]): boolean {
  return documents.some((document) => document.records.some((record) => /ignore (all )?(previous|prior) instructions|system prompt|developer message|reveal (your )?credentials/iu.test(record.canonical_text)));
}

function installInterruptHandler(workspace: Workspace): () => void {
  let handling = false;
  const handle = (signal: "SIGINT" | "SIGTERM") => {
    if (handling) return;
    handling = true;
    void (async () => {
      const current = await getState(workspace);
      const workerStatuses = Object.fromEntries(Object.entries(current.worker_statuses).map(([themeId, status]) => [themeId, status === "running" ? "abandoned" : status]));
      await appendEvent(workspace, "interrupted", "coordinator", { signal, previous_state: current.state });
      await transitionState(workspace, "interrupted", { active_review_stage: null, worker_statuses: workerStatuses });
      await releaseLock(workspace);
      process.exit(signal === "SIGINT" ? 130 : 143);
    })().catch(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
  return () => {
    process.off("SIGINT", handle);
    process.off("SIGTERM", handle);
  };
}

async function writeArtifact(workspace: Workspace, relativePath: string, value: unknown | Buffer, raw = false): Promise<void> {
  if (raw) await writeImmutableFile(artifactPath(workspace, relativePath), value as Buffer);
  else await writeImmutableJson(artifactPath(workspace, relativePath), value);
  await recordArtifact(workspace, relativePath);
}

async function reserveAgentCall(workspace: Workspace, role: "mapper" | "theme_worker", themeId: string | null): Promise<boolean> {
  const state = await getState(workspace);
  if (state.remaining_agent_calls <= 0) return false;
  await appendEvent(workspace, "worker_started", "coordinator", { role, theme_id: themeId, attempt: state.used_agent_calls + 1 });
  await transitionState(workspace, state.state, {
    used_agent_calls: state.used_agent_calls + 1,
    remaining_agent_calls: state.remaining_agent_calls - 1,
    worker_statuses: themeId ? { ...state.worker_statuses, [themeId]: "running" } : state.worker_statuses,
  });
  return true;
}

async function finishAgentCall(workspace: Workspace, role: "mapper" | "theme_worker", themeId: string | null, outcome: string): Promise<void> {
  const state = await getState(workspace);
  await appendEvent(workspace, "worker_finished", "worker", { role, theme_id: themeId, outcome });
  if (themeId) await transitionState(workspace, state.state, { worker_statuses: { ...state.worker_statuses, [themeId]: outcome } });
}

async function mapperAttempt(workspace: Workspace, input: RunInput, packet: unknown, attempt: number): Promise<RawThemeAttempt> {
  if (!await reserveAgentCall(workspace, "mapper", null)) return { attempt, artifact: null, result: null, error: "call_budget_exhausted" };
  try {
    const delegate = await invokeSemanticDelegate({ role: "mapper", profile: input.profile, timeoutSeconds: input.agentTimeoutSeconds, workspace, contextPacket: packet, attempt });
    await recordArtifact(workspace, delegate.artifact);
    const resultArtifact = `planning/mapper-result-${attempt}.json`;
    await writeArtifact(workspace, resultArtifact, delegate.value);
    await finishAgentCall(workspace, "mapper", null, delegate.process.outcome);
    return { attempt, artifact: resultArtifact, result: delegate.value, error: delegate.process.outcome === "ok" ? null : delegate.process.outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendOperationalLog(workspace, "error", "mapper", "delegate_failed", "Mapper delegate failed before producing a durable result.", { error: message });
    await finishAgentCall(workspace, "mapper", null, "failed");
    return { attempt, artifact: null, result: null, error: message };
  }
}

async function createPlan(workspace: Workspace, input: RunInput, documents: NormalizedDocument[], round: number, amendment: string | null = null): Promise<ApprovedPlan> {
  const mapperPacket = buildMapperPacket(input.profile, documents);
  const packet = amendment ? { ...mapperPacket, amendment } : mapperPacket;
  await writeArtifact(workspace, `context/mapper/packet-${round}.json`, packet);
  const primary = await mapperAttempt(workspace, input, packet, (await getState(workspace)).used_agent_calls + 1);
  let mapper = primary;
  if (mapper.error || !mapper.artifact || !mapperProposalSchema.safeParse(mapper.result).success) {
    if (round > 1 || (await getState(workspace)).used_agent_calls >= 2) throw new RegCompareError("mapper_failed", "Mapper revision failed after the allowed semantic amendment.", 5);
    mapper = await mapperAttempt(workspace, input, packet, (await getState(workspace)).used_agent_calls + 1);
  }
  if (mapper.error || !mapper.artifact || !mapperProposalSchema.safeParse(mapper.result).success) throw new RegCompareError("mapper_failed", "Mapper failed after its single corrective retry.", 5);
  const used = (await getState(workspace)).used_agent_calls;
  const { plan, packets } = deriveApprovedPlan(input.profile, mapper.result, documents, round, mapper.artifact, input, used);
  for (const [id, themePacket] of packets) await writeArtifact(workspace, `context/${id.match(/^thm-\d{3}/u)?.[0] ?? "thm-000"}/packet.json`, themePacket);
  await writeArtifact(workspace, `planning/plan-${round}.json`, plan);
  return plan;
}

async function nextThemeAttempt(workspace: Workspace, themeId: string): Promise<number> {
  const directory = artifactPath(workspace, `workers/${themeId.match(/^thm-\d{3}/u)?.[0] ?? "thm-000"}`);
  try {
    const attempts = (await readdir(directory)).map((name) => /^attempt-(\d+)\.json$/u.exec(name)?.[1]).filter((value): value is string => Boolean(value)).map(Number);
    return Math.max(0, ...attempts) + 1;
  } catch {
    return 1;
  }
}

async function invokeTheme(workspace: Workspace, input: RunInput, pending: PendingTheme, attempt: number, reserve = reserveAgentCall, finish = finishAgentCall): Promise<RawThemeAttempt> {
  if (!await reserve(workspace, "theme_worker", pending.theme.theme_id)) return { attempt, artifact: null, result: null, error: "call_budget_exhausted" };
  try {
    const delegate = await invokeSemanticDelegate({ role: "theme_worker", profile: input.profile, timeoutSeconds: input.agentTimeoutSeconds, workspace, contextPacket: pending.packet, themeId: pending.theme.theme_id, attempt });
    await recordArtifact(workspace, delegate.artifact);
    await finish(workspace, "theme_worker", pending.theme.theme_id, delegate.process.outcome);
    return { attempt, artifact: delegate.artifact, result: delegate.value, error: delegate.process.outcome === "ok" ? null : delegate.process.outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendOperationalLog(workspace, "error", "theme_worker", "delegate_failed", "Theme delegate failed before producing a durable result.", { theme_id: pending.theme.theme_id, error: message });
    await finish(workspace, "theme_worker", pending.theme.theme_id, "failed");
    return { attempt, artifact: null, result: null, error: message };
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async (): Promise<void> => {
    const current = index;
    index += 1;
    if (current >= items.length) return;
    await run(items[current]!);
    await worker();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function rawOutcome(value: unknown): { outcome: "assessed" | "no_material_change" | "not_assessable"; outcome_rationale: string } {
  const candidate = value as { outcome?: unknown; outcome_rationale?: unknown };
  if (candidate.outcome === "assessed" || candidate.outcome === "no_material_change" || candidate.outcome === "not_assessable") {
    return { outcome: candidate.outcome, outcome_rationale: typeof candidate.outcome_rationale === "string" ? candidate.outcome_rationale : "Worker result was audited." };
  }
  return { outcome: "not_assessable", outcome_rationale: "Worker result did not meet the required output schema." };
}

async function analyzePlan(workspace: Workspace, input: RunInput, plan: ApprovedPlan, documents: NormalizedDocument[]): Promise<{ themes: ThemeResult[]; exclusions: Analysis["excluded_themes"]; audit: { claims: unknown[]; rejected: unknown[]; duplicate_decisions: unknown[] } }> {
  const pending: PendingTheme[] = plan.themes.map((theme) => ({
    theme,
    packet: buildThemePacket({ theme_id: theme.theme_id, label: theme.label, description: theme.description, keywords: theme.keywords, seed_record_ids: theme.seed_record_ids }, documents),
    attempts: [],
  }));
  let reservationQueue = Promise.resolve();
  let finishQueue = Promise.resolve();
  const reserveSerialized = async (target: Workspace, role: "mapper" | "theme_worker", themeId: string | null): Promise<boolean> => {
    const reservation = reservationQueue.then(() => reserveAgentCall(target, role, themeId));
    reservationQueue = reservation.then(() => undefined, () => undefined);
    return reservation;
  };
  const finishSerialized = async (target: Workspace, role: "mapper" | "theme_worker", themeId: string | null, outcome: string): Promise<void> => {
    const completion = finishQueue.then(() => finishAgentCall(target, role, themeId, outcome));
    finishQueue = completion.then(() => undefined, () => undefined);
    return completion;
  };
  await mapWithConcurrency(pending, input.concurrency, async (theme) => {
    const attempt = await nextThemeAttempt(workspace, theme.theme.theme_id);
    theme.attempts.push(await invokeTheme(workspace, input, theme, attempt, reserveSerialized, finishSerialized));
  });
  const documentsById = new Map(documents.map((document) => [document.document_id, document]));
  const completed: CompletedTheme[] = [];
  const exclusions: Analysis["excluded_themes"] = [];
  const claims: unknown[] = [];
  const rejected: unknown[] = [];
  const duplicateDecisions: unknown[] = [];
  for (const theme of pending) {
    let current = theme.attempts[0] ?? { attempt: 0, artifact: null, result: null, error: "worker_not_started" };
    let audit = current.artifact ? auditThemeResult(input.profile, current.result, documentsById, current.artifact, theme.theme.theme_id, completed.flatMap((item) => item.audited.accepted)) : null;
    if ((current.error || audit?.workerLevelFailure) && current.attempt < 2) {
      const retry = await invokeTheme(workspace, input, theme, current.attempt + 1, reserveSerialized, finishSerialized);
      theme.attempts.push(retry);
      current = retry;
      audit = retry.artifact ? auditThemeResult(input.profile, retry.result, documentsById, retry.artifact, theme.theme.theme_id, completed.flatMap((item) => item.audited.accepted)) : null;
    }
    if (current.error || !audit || audit.workerLevelFailure) {
      exclusions.push({
        theme_id: theme.theme.theme_id,
        reason_code: current.error === "call_budget_exhausted" ? "call_budget_exhausted" : "worker_retry_exhausted",
        attempt_artifacts: theme.attempts.flatMap((attempt) => attempt.artifact ? [attempt.artifact] : []),
        description: current.error ?? audit?.reason ?? "The worker did not produce a defensible audited result.",
      });
      continue;
    }
    claims.push(...audit.claims);
    rejected.push(...audit.rejected);
    duplicateDecisions.push(...audit.duplicate_decisions);
    completed.push({ theme: theme.theme, packet: theme.packet, audited: audit, raw: rawOutcome(current.result), attemptArtifacts: theme.attempts.flatMap((attempt) => attempt.artifact ? [attempt.artifact] : []) });
  }
  let nextFindingId = 1;
  const themes: ThemeResult[] = [];
  for (const item of completed) {
    const findings = applyFindingIds(item.audited.accepted, nextFindingId);
    nextFindingId += findings.length;
    themes.push({
      theme_id: item.theme.theme_id,
      label: item.theme.label,
      status: "complete",
      outcome: item.raw.outcome,
      outcome_rationale: item.raw.outcome_rationale,
      attempt_artifacts: item.attemptArtifacts,
      context_packet_path: item.theme.context_packet_path,
      findings,
      rejected_finding_references: item.audited.rejected.length ? ["audit/rejected-findings-1.json"] : [],
      coverage: { included_records: item.packet.coverage.included_record_ids.length, candidate_records: item.packet.coverage.candidate_record_ids.length, context_truncated: item.packet.coverage.context_truncated },
    });
    await writeArtifact(workspace, `workers/${item.theme.theme_id.match(/^thm-\d{3}/u)?.[0] ?? "thm-000"}/theme-result-1.json`, themes.at(-1)!);
  }
  await writeArtifact(workspace, "audit/citation-audit-1.json", { schema_version: "1.0", audit_round: 1, claims, duplicate_decisions: duplicateDecisions });
  await writeArtifact(workspace, "audit/rejected-findings-1.json", { schema_version: "1.0", audit_round: 1, rejected });
  return { themes, exclusions, audit: { claims, rejected, duplicate_decisions: duplicateDecisions } };
}

function coverageFor(plan: ApprovedPlan, themes: ThemeResult[], excluded: Analysis["excluded_themes"], mapperBodySampleRatio: number): Analysis["coverage"] {
  const findings = themes.flatMap((theme) => theme.findings);
  return {
    ingestion_page_ratio: { baseline: 1, candidate: 1 },
    mapper_heading_ratio: 1,
    mapper_body_sample_ratio: mapperBodySampleRatio,
    theme_outcome_ratio: plan.themes.length === 0 ? 0 : themes.length / plan.themes.length,
    verified_finding_ratio: findings.length === 0 ? 1 : findings.filter((finding) => finding.evidence.every((citation) => citation.verified)).length / findings.length,
    fixture_required_concept_ratio: null,
    per_theme: Object.fromEntries([...themes.map((theme) => [theme.theme_id, { status: theme.status, coverage: theme.coverage }]), ...excluded.map((theme) => [theme.theme_id, { status: "excluded", reason_code: theme.reason_code }])]),
  };
}

function summary(themes: ThemeResult[]): Analysis["summary"] {
  const result = { critical: 0, high: 0, medium: 0, low: 0, no_material_change: 0 };
  for (const finding of themes.flatMap((theme) => theme.findings)) result[finding.materiality] += 1;
  return result;
}

function withReviewDispositions(themes: ThemeResult[], review: Analysis["final_review"]): ThemeResult[] {
  const dispositions = new Map(review.dispositions.map((disposition) => [disposition.finding_id, disposition.value]));
  return themes.map((theme) => ({
    ...theme,
    findings: theme.findings.map((finding) => ({
      ...finding,
      action_candidate: finding.action_candidate ? { ...finding.action_candidate, review_disposition: dispositions.get(finding.id) ?? "not_required" } : null,
    })),
  }));
}

async function finalize(workspace: Workspace, plan: ApprovedPlan, input: RunInput, documents: IngestedDocument[], themes: ThemeResult[], exclusions: Analysis["excluded_themes"], finalReview: Analysis["final_review"], mapperBodySampleRatio: number): Promise<void> {
  const resolvedThemes = withReviewDispositions(themes, finalReview);
  const limitations = ["Comparison is advisory analysis and not legal advice or a compliance determination."];
  if (input.profile === "policy-gap") limitations.push("The policy-gap profile assesses public policy posture only, not the complete internal control environment.");
  if (containsInjectionSignals(documents.map((document) => document.normalized))) limitations.push("One or more source segments contained prompt-injection indicators; they were retained as evidence and treated as untrusted content.");
  const provisional: Analysis = {
    schema_version: "1.0",
    run_id: workspace.runId,
    profile: input.profile,
    completion_status: exclusions.length ? "partial" : "complete",
    sources: documents.map((document) => document.ref),
    themes: resolvedThemes,
    summary: summary(resolvedThemes),
    excluded_themes: exclusions,
    coverage: coverageFor(plan, resolvedThemes, exclusions, mapperBodySampleRatio),
    final_review: finalReview,
    limitations,
    rendered_report_sha256: "0".repeat(64),
  };
  const analysis = analysisSchema.parse({ ...provisional, rendered_report_sha256: reportHash(provisional, input.dataClassification) });
  const report = renderReport(analysis, input.dataClassification);
  await writeArtifact(workspace, "analysis.json", analysis);
  await writeArtifact(workspace, "report.md", Buffer.from(report), true);
  await transitionState(workspace, "finalized", { active_review_stage: null, final_artifact_paths: ["analysis.json", "report.md"] });
}

async function runPlan(workspace: Workspace, input: RunInput, documents: IngestedDocument[], plan: ApprovedPlan): Promise<void> {
  const planReview = await collectReview({ autoApprove: input.autoApprove, plan, round: plan.round });
  await saveReview(workspace, planReview);
  if (planReview.decision === "rejected") {
    await transitionState(workspace, "cancelled", { active_review_stage: null });
    throw new RegCompareError("plan_rejected", "Reviewer rejected the analysis plan.", 5);
  }
  if (planReview.decision === "amended") {
    if (plan.round >= 2 || (await getState(workspace)).used_agent_calls >= 2) throw new RegCompareError("plan_amendment_limit", "Only one semantic plan amendment is allowed per run.", 5);
    await transitionState(workspace, "mapping", { active_review_stage: null });
    const revised = await createPlan(workspace, input, documents.map((document) => document.normalized), 2, planReview.amendment);
    await transitionState(workspace, "awaiting_plan_review", { active_plan_path: null, active_review_stage: "plan" });
    return runPlan(workspace, input, documents, revised);
  }
  await continueApprovedPlan(workspace, input, documents, plan);
}

async function continueApprovedPlan(workspace: Workspace, input: RunInput, documents: IngestedDocument[], plan: ApprovedPlan): Promise<void> {
  await transitionState(workspace, "analyzing", { active_plan_path: `planning/plan-${plan.round}.json`, active_review_stage: null });
  const analysis = await analyzePlan(workspace, input, plan, documents.map((document) => document.normalized));
  await transitionState(workspace, "auditing");
  const mapperPacket = await readJson<{ coverage: { body_sample_ratio: number } }>(artifactPath(workspace, `context/mapper/packet-${plan.round}.json`));
  await writeArtifact(workspace, "audit/coverage-1.json", coverageFor(plan, analysis.themes, analysis.exclusions, mapperPacket.coverage.body_sample_ratio));
  if (analysis.exclusions.length) {
    if (!input.allowPartial) {
      await transitionState(workspace, "failed");
      throw new RegCompareError("partial_not_allowed", "One or more themes failed and --allow-partial was not specified.", 5);
    }
    await transitionState(workspace, "blocked_partial", { active_review_stage: "partial" });
    const partialReview = await collectReview({ autoApprove: false, partial: true, round: plan.round });
    await saveReview(workspace, partialReview);
    if (partialReview.decision !== "confirmed_partial") {
      await transitionState(workspace, "cancelled", { active_review_stage: null });
      throw new RegCompareError("partial_review_rejected", "Reviewer did not confirm partial finalization.", 5);
    }
    await finalize(workspace, plan, input, documents, analysis.themes, analysis.exclusions, partialReview, mapperPacket.coverage.body_sample_ratio);
    return;
  }
  await finalizeWithReview(workspace, input, documents, plan, analysis.themes, [], mapperPacket.coverage.body_sample_ratio);
}

async function finalizeWithReview(workspace: Workspace, input: RunInput, documents: IngestedDocument[], plan: ApprovedPlan, themes: ThemeResult[], exclusions: Analysis["excluded_themes"], mapperBodySampleRatio: number): Promise<void> {
  const findingList = themes.flatMap((theme) => theme.findings);
  await transitionState(workspace, "awaiting_final_review", { active_review_stage: "final" });
  const review = await collectReview({ autoApprove: input.autoApprove, findings: findingList, round: plan.round });
  await saveReview(workspace, review);
  ensureFinalReview(review, findingList);
  await finalize(workspace, plan, input, documents, themes, exclusions, review, mapperBodySampleRatio);
}

export async function runComparison(rawInput: RunInput | Parameters<typeof parseRunInput>[0]): Promise<RunResult> {
  const input = typeof rawInput.maxThemes === "number" && typeof rawInput.concurrency === "number" && typeof rawInput.agentCallBudget === "number"
    ? rawInput as RunInput
    : parseRunInput(rawInput as RawRunInput);
  await validateSourceInputs(input);
  const documents = [
    await ingestDocument("baseline", input.baseline, { maxPages: input.maxSourcePages, maxChars: input.maxSourceChars }),
    await ingestDocument("candidate", input.candidate, { maxPages: input.maxSourcePages, maxChars: input.maxSourceChars }),
  ];
  if (input.dryRun) {
    return { run_directory: input.output, run_id: null, state: "dry_run", dry_run: true, plan: { effective_theme_cap: Math.min(input.maxThemes, input.agentCallBudget - 1), remaining_agent_calls: input.agentCallBudget - 1, source_stats: sourceStats(documents) } };
  }
  await assertDoctor();
  const workspace = await createWorkspace(input.output, { profile: input.profile, options: runOptions(input), data_classification: input.dataClassification, documents: documents.map((document) => document.ref), normalization_version: "canon-v1" });
  await acquireLock(workspace);
  const removeInterruptHandler = installInterruptHandler(workspace);
  try {
    await transitionState(workspace, "ingesting");
    for (const document of documents) {
      await writeArtifact(workspace, document.ref.raw_artifact_path, document.source, true);
      await writeArtifact(workspace, document.ref.normalized_artifact_path, document.normalized);
    }
    await writeArtifact(workspace, "sources/source-stats.json", sourceStats(documents));
    await transitionState(workspace, "normalized");
    await transitionState(workspace, "mapping");
    const plan = await createPlan(workspace, input, documents.map((document) => document.normalized), 1);
    await transitionState(workspace, "awaiting_plan_review", { active_plan_path: null, active_review_stage: "plan" });
    await runPlan(workspace, input, documents, plan);
    return { run_directory: workspace.root, run_id: workspace.runId, state: "finalized", dry_run: false };
  } catch (error) {
    const current = await getState(workspace);
    if (!(["failed", "cancelled", "finalized"] as string[]).includes(current.state)) await transitionState(workspace, "failed");
    throw error;
  } finally {
    removeInterruptHandler();
    await releaseLock(workspace);
  }
}

async function latestPlan(workspace: Workspace): Promise<ApprovedPlan> {
  const files = (await readdir(artifactPath(workspace, "planning"))).filter((name) => /^plan-\d+\.json$/u.test(name)).sort();
  const latest = files.at(-1);
  if (!latest) throw new RegCompareError("resume_plan_missing", "Run has no resumable approved-plan artifact.", 6);
  return approvedPlanSchema.parse(await readJson(artifactPath(workspace, `planning/${latest}`)));
}

async function resumeDocuments(workspace: Workspace): Promise<IngestedDocument[]> {
  const manifest = await getManifest(workspace);
  return Promise.all((["baseline", "candidate"] as const).map(async (id) => {
    const ref = manifest.documents.find((document) => document.document_id === id);
    if (!ref) throw new RegCompareError("resume_source_missing", `Run manifest has no ${id} source.`, 6);
    return {
      normalized: normalizedDocumentSchema.parse(await readJson(artifactPath(workspace, `sources/normalized/${id}.json`))),
      source: await readFile(artifactPath(workspace, ref.raw_artifact_path)),
      ref,
      sourceStats: {} as IngestedDocument["sourceStats"],
    };
  }));
}

async function resumedThemes(workspace: Workspace, plan: ApprovedPlan): Promise<ThemeResult[]> {
  return Promise.all(plan.themes.map(async (theme) => {
    const path = artifactPath(workspace, `workers/${theme.theme_id.match(/^thm-\d{3}/u)?.[0] ?? "thm-000"}/theme-result-1.json`);
    try {
      return themeResultSchema.parse(await readJson(path));
    } catch {
      throw new RegCompareError("resume_theme_missing", `Accepted result for ${theme.theme_id} is missing or invalid.`, 6);
    }
  }));
}

async function mapperSampleRatio(workspace: Workspace, plan: ApprovedPlan): Promise<number> {
  const packet = await readJson<{ coverage?: { body_sample_ratio?: unknown } }>(artifactPath(workspace, `context/mapper/packet-${plan.round}.json`));
  return typeof packet.coverage?.body_sample_ratio === "number" ? packet.coverage.body_sample_ratio : 0;
}

async function resumePartial(workspace: Workspace, input: RunInput, documents: IngestedDocument[], plan: ApprovedPlan): Promise<void> {
  const themes = await resumedThemes(workspace, plan).catch(() => [] as ThemeResult[]);
  const completeThemeIds = new Set(themes.map((theme) => theme.theme_id));
  const exclusions: Analysis["excluded_themes"] = plan.themes.filter((theme) => !completeThemeIds.has(theme.theme_id)).map((theme) => ({
    theme_id: theme.theme_id,
    reason_code: "worker_retry_exhausted",
    attempt_artifacts: [],
    description: "The theme was excluded before the run was interrupted or blocked.",
  }));
  if (!exclusions.length) throw new RegCompareError("resume_partial_invalid", "Partial run has no excluded themes.", 6);
  await transitionState(workspace, "awaiting_partial_review", { active_review_stage: "partial" });
  const review = await collectReview({ autoApprove: false, partial: true, round: plan.round });
  await saveReview(workspace, review);
  if (review.decision !== "confirmed_partial") {
    await transitionState(workspace, "cancelled", { active_review_stage: null });
    throw new RegCompareError("partial_review_rejected", "Reviewer did not confirm partial finalization.", 5);
  }
  await finalize(workspace, plan, input, documents, themes, exclusions, review, await mapperSampleRatio(workspace, plan));
}

export async function resumeComparison(runDirectory: string, autoApprove: boolean): Promise<RunResult> {
  const workspace = await assertWorkspace(runDirectory);
  await validateLedger(workspace);
  let state = await getState(workspace);
  if (state.state === "finalized") return { run_directory: workspace.root, run_id: workspace.runId, state: state.state, dry_run: false };
  const manifest = await getManifest(workspace);
  const input: RunInput = { ...manifest.options, baseline: "", candidate: "", output: workspace.root, dryRun: false, autoApprove };
  await acquireLock(workspace);
  const removeInterruptHandler = installInterruptHandler(workspace);
  try {
    if (state.state === "interrupted") {
      const interruption = await readEvent(workspace, state.last_event_sequence);
      const priorState = typeof interruption.payload.previous_state === "string" ? interruption.payload.previous_state : interruption.payload.from;
      if (typeof priorState !== "string") throw new RegCompareError("resume_state_missing", "Interrupted run has no recoverable prior state.", 6);
      const workerStatuses = Object.fromEntries(Object.entries(state.worker_statuses).map(([themeId, status]) => [themeId, status === "running" ? "abandoned" : status]));
      await transitionState(workspace, priorState as typeof state.state, { worker_statuses: workerStatuses, active_review_stage: priorState.startsWith("awaiting_") ? state.active_review_stage : null });
      state = await getState(workspace);
    }
    const documents = await resumeDocuments(workspace);
    if (state.state === "awaiting_plan_review") {
      await runPlan(workspace, input, documents, await latestPlan(workspace));
    } else if (state.state === "awaiting_final_review") {
      const plan = await latestPlan(workspace);
      await finalizeWithReview(workspace, input, documents, plan, await resumedThemes(workspace, plan), [], await mapperSampleRatio(workspace, plan));
    } else if (state.state === "blocked_partial" || state.state === "awaiting_partial_review") {
      await resumePartial(workspace, input, documents, await latestPlan(workspace));
    } else if (state.state === "mapping") {
      await assertDoctor();
      const plan = await createPlan(workspace, input, documents.map((document) => document.normalized), 1);
      await transitionState(workspace, "awaiting_plan_review", { active_plan_path: null, active_review_stage: "plan" });
      await runPlan(workspace, input, documents, plan);
    } else if (state.state === "analyzing" || state.state === "auditing") {
      const plan = await latestPlan(workspace);
      await assertDoctor();
      await continueApprovedPlan(workspace, input, documents, plan);
    } else {
      throw new RegCompareError("resume_not_supported_state", `Run cannot be resumed safely from ${state.state}.`, 6);
    }
    const finalState = await getState(workspace);
    return { run_directory: workspace.root, run_id: workspace.runId, state: finalState.state, dry_run: false };
  } finally {
    removeInterruptHandler();
    await releaseLock(workspace);
  }
}
