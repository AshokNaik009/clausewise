import { z } from "zod";

export const profileSchema = z.enum(["consultation-impact", "version-change", "cross-guidance", "policy-gap"]);
export const classificationSchema = z.enum(["public", "internal", "confidential"]);
export const documentIdSchema = z.enum(["baseline", "candidate"]);
export const sourceFormatSchema = z.enum(["pdf", "markdown", "text"]);
export const materialitySchema = z.enum(["critical", "high", "medium", "low", "no_material_change"]);
export const themeOutcomeSchema = z.enum(["assessed", "no_material_change", "not_assessable"]);

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
  schema_version: z.literal("1.0"),
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
  raw_artifact_path: z.string(),
  normalized_artifact_path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  page_count: z.number().int().positive(),
  record_count: z.number().int().positive(),
  canonicalization_version: z.literal("canon-v1"),
});

export const citationClaimSchema = z.object({
  document_id: documentIdSchema,
  start_record_id: z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/),
  end_record_id: z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/),
  excerpt: z.string().min(1).max(4_000),
});

const workerActionSchema = z.object({
  description: z.string().min(1).max(2_000),
  action_type: z.enum(["assess", "implement", "monitor", "respond", "validate"]),
});

export const workerFindingSchema = z.object({
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(4_000),
  materiality: materialitySchema,
  materiality_rationale: z.string().min(1).max(2_000),
  confidence: z.enum(["high", "medium", "low"]),
  citation_claims: z.array(citationClaimSchema).min(1),
  action_candidate: workerActionSchema.nullable(),
  profile_assessment: z.record(z.string(), z.unknown()),
});

export const themeWorkerResultSchema = z.object({
  schema_version: z.literal("1.0"),
  outcome: themeOutcomeSchema,
  outcome_rationale: z.string().min(1).max(2_000),
  candidate_findings: z.array(workerFindingSchema),
});

export const mapperProposalSchema = z.object({
  schema_version: z.literal("1.0"),
  proposals: z.array(z.object({
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    keywords: z.array(z.string().min(1).max(80)).min(1).max(12),
    ranking_rationale: z.string().min(1).max(1_000),
    seed_record_ids: z.array(z.string().regex(/^(baseline|candidate):p\d{4}:l\d{6}$/)).min(1).max(20),
  })).min(1).max(12),
});

export const runStateSchema = z.object({
  schema_version: z.literal("1.0"),
  run_id: z.string().uuid(),
  state: z.enum(["created", "ingesting", "normalized", "mapping", "awaiting_plan_review", "analyzing", "auditing", "awaiting_final_review", "blocked_partial", "awaiting_partial_review", "finalized", "failed", "cancelled", "interrupted"]),
  updated_at: z.string().datetime(),
  active_plan_path: z.string().nullable(),
  active_review_stage: z.enum(["plan", "final", "partial"]).nullable(),
  used_agent_calls: z.number().int().nonnegative(),
  remaining_agent_calls: z.number().int().nonnegative(),
  worker_statuses: z.record(z.string(), z.string()),
  final_artifact_paths: z.array(z.string()),
  last_event_sequence: z.number().int().nonnegative(),
});

export type Profile = z.infer<typeof profileSchema>;
export type Classification = z.infer<typeof classificationSchema>;
export type DocumentId = z.infer<typeof documentIdSchema>;
export type SourceFormat = z.infer<typeof sourceFormatSchema>;
export type NormalizedRecord = z.infer<typeof normalizedRecordSchema>;
export type NormalizedDocument = z.infer<typeof normalizedDocumentSchema>;
export type DocumentRef = z.infer<typeof documentRefSchema>;
export type CitationClaim = z.infer<typeof citationClaimSchema>;
export type ThemeWorkerResult = z.infer<typeof themeWorkerResultSchema>;
export type MapperProposal = z.infer<typeof mapperProposalSchema>;
export type RunState = z.infer<typeof runStateSchema>;
