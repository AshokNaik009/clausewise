import { canonicalizeExcerpt } from "./normalization.js";
import { citationFingerprint, verifyCitation, type VerifiedCitation } from "./citations.js";
import { profileAssessmentSchemas, themeWorkerResultSchema, type Finding, type NormalizedDocument, type Profile, type ThemeWorkerResult } from "./schemas.js";

export interface RejectedFinding {
  worker_artifact_path: string;
  candidate_index: number;
  reason_codes: string[];
  escalates_theme_failure: boolean;
}

export interface CitationAuditClaim {
  claim_reference: string;
  finding_reference: string;
  outcome: "accepted" | "rejected";
  reason_code: string | null;
  derived_citation: VerifiedCitation | null;
  fingerprint: string | null;
}

export interface AuditResult {
  accepted: (Omit<Finding, "id" | "action_candidate"> & { action_candidate: { description: string; action_type: "assess" | "implement" | "monitor" | "respond" | "validate"; review_disposition: "not_required" } | null })[];
  rejected: RejectedFinding[];
  claims: CitationAuditClaim[];
  duplicate_decisions: { outcome: "deduplicated_within_finding" | "reused_across_findings" | "duplicate_finding"; finding_reference: string; related_finding_reference?: string }[];
  workerLevelFailure: boolean;
  reason: string | null;
}

function validateAssessment(profile: Profile, value: unknown): boolean {
  return profileAssessmentSchemas[profile].safeParse(value).success;
}

function hasBothSources(citations: VerifiedCitation[]): boolean {
  return new Set(citations.map((citation) => citation.document_id)).size === 2;
}

function auditCandidate(profile: Profile, result: ThemeWorkerResult, candidateIndex: number, documents: Map<string, NormalizedDocument>, workerArtifactPath: string): { finding: AuditResult["accepted"][number] | null; rejected: RejectedFinding | null; claims: CitationAuditClaim[]; fingerprints: string[] } {
  const candidate = result.candidate_findings[candidateIndex];
  if (!candidate) throw new Error("Candidate finding is absent.");
  const reasons: string[] = [];
  if (!validateAssessment(profile, candidate.profile_assessment)) reasons.push("invalid_profile_assessment");
  if ((candidate.materiality === "critical" || candidate.materiality === "high") && !candidate.action_candidate) reasons.push("missing_required_action");
  if (candidate.materiality === "no_material_change" && candidate.action_candidate !== null) reasons.push("unexpected_no_change_action");
  const claims: CitationAuditClaim[] = [];
  const evidence: VerifiedCitation[] = [];
  const seen = new Set<string>();
  for (const [claimIndex, claim] of candidate.citation_claims.entries()) {
    const verified = verifyCitation(documents, claim);
    if ("code" in verified) {
      reasons.push(verified.code);
      claims.push({ claim_reference: `${candidateIndex}:${claimIndex}`, finding_reference: String(candidateIndex), outcome: "rejected", reason_code: verified.code, derived_citation: null, fingerprint: null });
      continue;
    }
    const fingerprint = citationFingerprint(verified);
    if (seen.has(fingerprint)) {
      claims.push({ claim_reference: `${candidateIndex}:${claimIndex}`, finding_reference: String(candidateIndex), outcome: "accepted", reason_code: "deduplicated_within_finding", derived_citation: verified, fingerprint });
      continue;
    }
    seen.add(fingerprint);
    evidence.push(verified);
    claims.push({ claim_reference: `${candidateIndex}:${claimIndex}`, finding_reference: String(candidateIndex), outcome: "accepted", reason_code: null, derived_citation: verified, fingerprint });
  }
  if (!evidence.length) reasons.push("no_verified_evidence");
  if (candidate.materiality === "no_material_change" && (!hasBothSources(evidence) || evidence.length < 2)) reasons.push("no_change_requires_scope_citations");
  if (reasons.length) {
    return {
      finding: null,
      rejected: { worker_artifact_path: workerArtifactPath, candidate_index: candidateIndex, reason_codes: [...new Set(reasons)], escalates_theme_failure: false },
      claims,
      fingerprints: [],
    };
  }
  return {
    finding: {
      theme_id: "thm-000-placeholder",
      title: candidate.title,
      summary: candidate.summary,
      materiality: candidate.materiality,
      materiality_rationale: candidate.materiality_rationale,
      confidence: candidate.confidence,
      evidence,
      action_candidate: candidate.action_candidate ? { ...candidate.action_candidate, review_disposition: "not_required" } : null,
      profile_assessment: candidate.profile_assessment,
    },
    rejected: null,
    claims,
    fingerprints: evidence.map(citationFingerprint),
  };
}

export function auditThemeResult(profile: Profile, untrustedResult: unknown, documents: Map<string, NormalizedDocument>, workerArtifactPath: string, themeId: string, previouslyAccepted: { theme_id: string; title: string; materiality: string; profile_assessment: unknown; evidence: VerifiedCitation[] }[] = []): AuditResult {
  const parsed = themeWorkerResultSchema.safeParse(untrustedResult);
  if (!parsed.success) return { accepted: [], rejected: [], claims: [], duplicate_decisions: [], workerLevelFailure: true, reason: "worker_schema_invalid" };
  const result = parsed.data;
  const accepted: AuditResult["accepted"] = [];
  const rejected: RejectedFinding[] = [];
  const claims: CitationAuditClaim[] = [];
  const duplicateDecisions: AuditResult["duplicate_decisions"] = [];
  const allAccepted = [...previouslyAccepted];
  for (const index of result.candidate_findings.keys()) {
    const audited = auditCandidate(profile, result, index, documents, workerArtifactPath);
    claims.push(...audited.claims);
    if (audited.rejected) {
      rejected.push(audited.rejected);
      continue;
    }
    if (!audited.finding) continue;
    audited.finding.theme_id = themeId;
    const fingerprints = audited.finding.evidence.map(citationFingerprint).sort();
    const duplicate = allAccepted.find((finding) => finding.theme_id === themeId
      && canonicalizeExcerpt(finding.title) === canonicalizeExcerpt(audited.finding!.title)
      && finding.materiality === audited.finding!.materiality
      && JSON.stringify(finding.profile_assessment) === JSON.stringify(audited.finding!.profile_assessment)
      && JSON.stringify(finding.evidence.map(citationFingerprint).sort()) === JSON.stringify(fingerprints));
    if (duplicate) {
      rejected.push({ worker_artifact_path: workerArtifactPath, candidate_index: index, reason_codes: ["duplicate_finding"], escalates_theme_failure: false });
      duplicateDecisions.push({ outcome: "duplicate_finding", finding_reference: String(index), related_finding_reference: duplicate.title });
      continue;
    }
    const reused = allAccepted.some((finding) => finding.evidence.some((citation) => fingerprints.includes(citationFingerprint(citation))));
    if (reused) duplicateDecisions.push({ outcome: "reused_across_findings", finding_reference: String(index) });
    for (const claim of audited.claims) {
      if (claim.reason_code === "deduplicated_within_finding") duplicateDecisions.push({ outcome: "deduplicated_within_finding", finding_reference: String(index) });
    }
    accepted.push(audited.finding);
    allAccepted.push(audited.finding);
  }
  const noPublishableOutcome = result.outcome === "assessed" && accepted.length === 0;
  const noChangeMissing = result.outcome === "no_material_change" && !accepted.some((finding) => finding.materiality === "no_material_change");
  if (noPublishableOutcome || noChangeMissing) {
    for (const rejection of rejected) rejection.escalates_theme_failure = true;
    return { accepted, rejected, claims, duplicate_decisions: duplicateDecisions, workerLevelFailure: true, reason: noPublishableOutcome ? "no_publishable_outcome" : "no_change_evidence_missing" };
  }
  return { accepted, rejected, claims, duplicate_decisions: duplicateDecisions, workerLevelFailure: false, reason: null };
}

export function applyFindingIds(findings: AuditResult["accepted"], startingAt: number): Finding[] {
  return findings.map((finding, index) => ({ ...finding, id: `F-${String(startingAt + index).padStart(4, "0")}` }));
}
