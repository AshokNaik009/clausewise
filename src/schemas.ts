import { z } from "zod";

export const schemaVersion = z.literal("1.0");
export const profileSchema = z.enum(["consultation-impact", "version-change", "cross-guidance", "policy-gap"]);
export const classificationSchema = z.enum(["public", "internal", "confidential"]);
export const documentIdSchema = z.enum(["baseline", "candidate"]);
export const sourceFormatSchema = z.enum(["pdf", "markdown", "text"]);
export const materialitySchema = z.enum(["critical", "high", "medium", "low", "no_material_change"]);
export const themeOutcomeSchema = z.enum(["assessed", "no_material_change", "not_assessable"]);
export const runStatusSchema = z.enum(["created", "ingesting", "normalized", "mapping", "awaiting_plan_review", "analyzing", "auditing", "awaiting_final_review", "blocked_partial", "awaiting_partial_review", "finalized", "failed", "cancelled", "interrupted"]);

export const normalizedRecordSchema = z.object({
  record_id: z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/),
  ordinal: z.number().int().positive(),
  page: z.number().int().positive().nullable(),
  page_line: z.number().int().positive().nullable(),
  global_line: z.number().int().positive(),
  heading: z.string().nullable(),
  raw_text: z.string(),
  canonical_text: z.string(),
  source_order: z.object({ page: z.number().int().positive().nullable(), page_line: z.number().int().positive().nullable() }),
});

export const normalizedDocumentSchema = z.object({
  schema_version: schemaVersion,
  canonicalization_version: z.literal("canon-v1"),
  document_id: documentIdSchema,
  format: sourceFormatSchema,
  records: z.array(normalizedRecordSchema).min(1),
});

export const documentRefSchema = z.object({
  document_id: documentIdSchema,
  display_name: z.string().min(1),
  format: sourceFormatSchema,
  language: z.literal("en"),
  raw_artifact_path: z.string().min(1),
  normalized_artifact_path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  page_count: z.number().int().positive(),
  record_count: z.number().int().positive(),
  canonicalization_version: z.literal("canon-v1"),
}).strict();

export const runOptionsSchema = z.object({
  profile: profileSchema,
  dataClassification: classificationSchema,
  maxThemes: z.number().int().min(1).max(6),
  concurrency: z.number().int().min(1).max(3),
  agentCallBudget: z.number().int().min(2).max(14),
  agentTimeoutSeconds: z.number().int().min(30).max(900),
  maxSourcePages: z.number().int().min(1).max(350),
  maxSourceChars: z.number().int().min(10_000).max(2_500_000),
  allowPartial: z.boolean(),
  autoApprove: z.boolean(),
  confirmExternalModelAccess: z.boolean(),
  confirmEncryptedWorkspace: z.boolean(),
  retentionUntil: z.string().datetime().nullable(),
}).strict();

export const modelProvenanceSchema = z.object({
  model: z.string().min(1),
  base_url: z.string().url(),
  temperature: z.literal(0),
  provider_order: z.array(z.string().min(1)).min(1),
  allow_fallbacks: z.literal(false),
  data_collection: z.literal("deny"),
}).strict();

export const runManifestSchema = z.object({
  schema_version: schemaVersion,
  run_id: z.string().uuid(),
  created_at: z.string().datetime(),
  profile: profileSchema,
  options: runOptionsSchema,
  data_classification: classificationSchema,
  model: modelProvenanceSchema,
  documents: z.array(documentRefSchema).length(2).refine((documents) => new Set(documents.map((document) => document.document_id)).size === 2, "Manifest documents must contain one baseline and one candidate source."),
  normalization_version: z.literal("canon-v1"),
}).strict().superRefine((manifest, context) => {
  if (manifest.profile !== manifest.options.profile) context.addIssue({ code: "custom", path: ["options", "profile"], message: "Manifest profile must match its run options." });
  if (manifest.data_classification !== manifest.options.dataClassification) context.addIssue({ code: "custom", path: ["options", "dataClassification"], message: "Manifest data classification must match its run options." });
});

export const citationClaimSchema = z.object({
  document_id: documentIdSchema,
  start_record_id: z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/),
  end_record_id: z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/),
  excerpt: z.string().min(1).max(4_000),
}).strict();

export const verifiedCitationSchema = citationClaimSchema.extend({
  page_start: z.number().int().positive().nullable(),
  page_end: z.number().int().positive().nullable(),
  global_line_start: z.number().int().positive(),
  global_line_end: z.number().int().positive(),
  heading_start: z.string().nullable(),
  heading_end: z.string().nullable(),
  excerpt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.literal(true),
});

export const workerActionSchema = z.object({
  description: z.string().min(1).max(2_000),
  action_type: z.enum(["assess", "implement", "monitor", "respond", "validate"]),
}).strict();

export const consultationAssessmentSchema = z.object({
  proposal_status: z.enum(["new", "amends", "removes", "clarifies"]),
  affected_obligation: z.string().min(1).max(2_000),
  implementation_consideration: z.string().min(1).max(2_000),
}).strict();
export const versionAssessmentSchema = z.object({
  change_type: z.enum(["added", "modified", "removed", "clarified"]),
  effective_or_publication_context: z.string().min(1).max(2_000),
}).strict();
export const guidanceAssessmentSchema = z.object({
  relationship: z.enum(["aligns", "adds_detail", "scope_difference", "conflicts"]),
  scope_comparison: z.string().min(1).max(2_000),
}).strict();
export const policyGapAssessmentSchema = z.object({
  gap_status: z.enum(["gap", "partial_alignment", "aligned", "not_assessable"]),
  public_policy_limitation: z.string().min(1).max(2_000),
}).strict();
export const profileAssessmentSchemas = {
  "consultation-impact": consultationAssessmentSchema,
  "version-change": versionAssessmentSchema,
  "cross-guidance": guidanceAssessmentSchema,
  "policy-gap": policyGapAssessmentSchema,
} as const;

export const workerFindingSchema = z.object({
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(4_000),
  materiality: materialitySchema,
  materiality_rationale: z.string().min(1).max(2_000),
  confidence: z.enum(["high", "medium", "low"]),
  citation_claims: z.array(citationClaimSchema).min(1).max(20),
  action_candidate: workerActionSchema.nullable(),
  profile_assessment: z.record(z.string(), z.unknown()),
}).strict();

export const themeWorkerResultSchema = z.object({
  schema_version: schemaVersion,
  outcome: themeOutcomeSchema,
  outcome_rationale: z.string().min(1).max(2_000),
  candidate_findings: z.array(workerFindingSchema).max(30),
}).strict();

export const delegateOutcomeSchema = z.enum(["ok", "model_error", "schema_invalid", "timeout", "budget_exhausted"]);
export const workerAttemptArtifactSchema = z.object({
  schema_version: schemaVersion,
  role: z.enum(["mapper", "theme_worker"]),
  theme_id: z.string().regex(/^thm-\d{3}-[a-z0-9]+(?:-[a-z0-9]+){0,8}$/).nullable(),
  command: z.literal("deepagents/openrouter"),
  timestamps: z.object({ completed_at: z.string().datetime() }).strict(),
  exit_status: z.number().int().nullable(),
  signal: z.string().nullable(),
  stderr_truncated: z.boolean(),
  stderr: z.string(),
  stdout: z.string(),
  outcome: delegateOutcomeSchema,
}).strict().superRefine((attempt, context) => {
  if ((attempt.role === "mapper") !== (attempt.theme_id === null)) context.addIssue({ code: "custom", message: "Mapper attempts must have no theme ID and theme-worker attempts must have one." });
  if (attempt.outcome === "ok" && attempt.exit_status !== 0) context.addIssue({ code: "custom", message: "Successful worker attempts must have exit status 0." });
  if (attempt.outcome !== "ok" && attempt.exit_status !== null) context.addIssue({ code: "custom", message: "Failed worker attempts must not claim a process exit status." });
});

export const mapperProposalSchema = z.object({
  schema_version: schemaVersion,
  proposals: z.array(z.object({
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    keywords: z.array(z.string().min(1).max(80)).min(1).max(12),
    ranking_rationale: z.string().min(1).max(1_000),
    seed_record_ids: z.array(z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/)).min(1).max(20),
  }).strict()).min(1).max(12),
}).strict();

export const themePlanSchema = z.object({
  theme_id: z.string().regex(/^thm-\d{3}-[a-z0-9]+(?:-[a-z0-9]+){0,8}$/),
  label: z.string().min(1),
  description: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  seed_record_ids: z.array(z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/)).min(1),
  context_packet_path: z.string().min(1),
}).strict();

export const approvedPlanSchema = z.object({
  schema_version: schemaVersion,
  plan_id: z.string().uuid(),
  round: z.number().int().positive(),
  mapper_artifact_path: z.string().min(1),
  themes: z.array(themePlanSchema).min(1).max(6),
  limits: z.object({ max_themes: z.number().int().min(1).max(6), theme_context_chars: z.literal(100_000), theme_context_records: z.literal(80) }).strict(),
  call_budget: z.object({ used: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(), maximum_remaining: z.number().int().nonnegative() }).strict(),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const reviewDispositionSchema = z.object({
  finding_id: z.string().regex(/^F-\d{4}$/),
  value: z.enum(["accepted", "deferred", "rejected", "needs_evidence"]),
}).strict();
export const reviewRecordSchema = z.object({
  schema_version: schemaVersion,
  review_id: z.string().uuid(),
  stage: z.enum(["plan", "final", "partial"]),
  round: z.number().int().positive(),
  mode: z.enum(["interactive", "automation"]),
  actor: z.enum(["local-user", "automation"]),
  decision: z.enum(["approved", "rejected", "amended", "confirmed_partial"]),
  amendment: z.string().nullable(),
  dispositions: z.array(reviewDispositionSchema),
  timestamp: z.string().datetime(),
}).strict();

export const findingSchema = z.object({
  id: z.string().regex(/^F-\d{4}$/),
  theme_id: themePlanSchema.shape.theme_id,
  title: z.string().min(1),
  summary: z.string().min(1),
  materiality: materialitySchema,
  materiality_rationale: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(verifiedCitationSchema).min(1),
  action_candidate: workerActionSchema.extend({ review_disposition: z.enum(["accepted", "deferred", "rejected", "needs_evidence", "not_required"]) }).nullable(),
  profile_assessment: z.record(z.string(), z.unknown()),
}).strict();

export const themeResultSchema = z.object({
  theme_id: themePlanSchema.shape.theme_id,
  label: z.string().min(1),
  status: z.enum(["complete", "degraded", "excluded"]),
  outcome: themeOutcomeSchema,
  outcome_rationale: z.string().min(1),
  attempt_artifacts: z.array(z.string()),
  context_packet_path: z.string().min(1),
  findings: z.array(findingSchema),
  rejected_finding_references: z.array(z.string()),
  coverage: z.object({ included_records: z.number().int().nonnegative(), candidate_records: z.number().int().nonnegative(), context_truncated: z.boolean() }).strict(),
}).strict();

export const excludedThemeSchema = z.object({
  theme_id: themePlanSchema.shape.theme_id,
  reason_code: z.enum(["worker_retry_exhausted", "call_budget_exhausted", "reviewer_excluded"]),
  attempt_artifacts: z.array(z.string()),
  description: z.string().min(1),
}).strict();

export const coverageMetricsSchema = z.object({
  ingestion_page_ratio: z.union([z.number().min(0).max(1), z.record(documentIdSchema, z.number().min(0).max(1))]),
  mapper_heading_ratio: z.number().min(0).max(1),
  mapper_body_sample_ratio: z.number().min(0).max(1),
  theme_outcome_ratio: z.number().min(0).max(1),
  verified_finding_ratio: z.number().min(0).max(1),
  fixture_required_concept_ratio: z.number().min(0).max(1).nullable(),
  per_theme: z.record(z.string(), z.unknown()),
}).strict();

export const analysisSchema = z.object({
  schema_version: schemaVersion,
  run_id: z.string().uuid(),
  profile: profileSchema,
  completion_status: z.enum(["complete", "partial"]),
  sources: z.array(documentRefSchema).length(2),
  themes: z.array(themeResultSchema),
  summary: z.object({ critical: z.number().int().nonnegative(), high: z.number().int().nonnegative(), medium: z.number().int().nonnegative(), low: z.number().int().nonnegative(), no_material_change: z.number().int().nonnegative() }).strict(),
  excluded_themes: z.array(excludedThemeSchema),
  coverage: coverageMetricsSchema,
  final_review: reviewRecordSchema,
  limitations: z.array(z.string()),
  rendered_report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const conversationProgressSchema = z.object({
  schema_version: schemaVersion,
  plan_round: z.number().int().positive(),
  themes: z.array(themeResultSchema),
  excluded_themes: z.array(excludedThemeSchema),
  mapper_body_sample_ratio: z.number().min(0).max(1),
}).strict();

export const eventSchema = z.object({
  schema_version: schemaVersion,
  run_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: z.enum(["state_transition", "artifact_created", "worker_started", "worker_finished", "model_call_started", "review_recorded", "interrupted", "purge_intent"]),
  timestamp: z.string().datetime(),
  actor: z.enum(["coordinator", "reviewer", "worker"]),
  payload: z.record(z.string(), z.unknown()),
  previous_event_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();

export const runStateSchema = z.object({
  schema_version: schemaVersion,
  run_id: z.string().uuid(),
  state: runStatusSchema,
  updated_at: z.string().datetime(),
  active_plan_path: z.string().nullable(),
  active_review_stage: z.enum(["plan", "final", "partial"]).nullable(),
  used_agent_calls: z.number().int().nonnegative(),
  remaining_agent_calls: z.number().int().nonnegative(),
  worker_statuses: z.record(z.string(), z.string()),
  final_artifact_paths: z.array(z.string()),
  last_event_sequence: z.number().int().nonnegative(),
}).strict();

export type Profile = z.infer<typeof profileSchema>;
export type Classification = z.infer<typeof classificationSchema>;
export type DocumentId = z.infer<typeof documentIdSchema>;
export type SourceFormat = z.infer<typeof sourceFormatSchema>;
export type RunOptionsData = z.infer<typeof runOptionsSchema>;
export type ModelProvenanceData = z.infer<typeof modelProvenanceSchema>;
export type RunManifestData = z.infer<typeof runManifestSchema>;
export type NormalizedRecord = z.infer<typeof normalizedRecordSchema>;
export type NormalizedDocument = z.infer<typeof normalizedDocumentSchema>;
export type DocumentRef = z.infer<typeof documentRefSchema>;
export type CitationClaim = z.infer<typeof citationClaimSchema>;
export type VerifiedCitationData = z.infer<typeof verifiedCitationSchema>;
export type ThemeWorkerResult = z.infer<typeof themeWorkerResultSchema>;
export type MapperProposal = z.infer<typeof mapperProposalSchema>;
export type ApprovedPlan = z.infer<typeof approvedPlanSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type ThemeResult = z.infer<typeof themeResultSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type ConversationProgress = z.infer<typeof conversationProgressSchema>;
export type EventRecord = z.infer<typeof eventSchema>;
export type RunState = z.infer<typeof runStateSchema>;
