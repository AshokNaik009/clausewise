import { describe, expect, it } from "vitest";
import { auditThemeResult } from "../../src/audit.js";

const record = (documentId: "baseline" | "candidate") => ({
  record_id: `${documentId}:p0001:l000001`,
  ordinal: 1,
  page: 1,
  page_line: 1,
  global_line: 1,
  heading: null,
  raw_text: `${documentId} obligation`,
  canonical_text: `${documentId} obligation`,
  source_order: { page: 1, page_line: 1 },
});

const documents = new Map(["baseline", "candidate"].map((documentId) => [documentId, {
  schema_version: "1.0" as const,
  canonicalization_version: "canon-v1" as const,
  document_id: documentId as "baseline" | "candidate",
  format: "text" as const,
  records: [record(documentId as "baseline" | "candidate")],
}]));

describe("citation audit", () => {
  it("rejects a worker result whose citations cannot be verified against normalized records", () => {
    const audit = auditThemeResult("version-change", {
      schema_version: "1.0",
      outcome: "assessed",
      outcome_rationale: "The worker identified a material change.",
      candidate_findings: [{
        title: "Unverifiable change",
        summary: "The citation points outside the normalized source.",
        materiality: "high",
        materiality_rationale: "It affects a regulatory obligation.",
        confidence: "high",
        citation_claims: [{ document_id: "baseline", start_record_id: "baseline:p0001:l000002", end_record_id: "baseline:p0001:l000002", excerpt: "missing text" }],
        action_candidate: { description: "Assess the obligation.", action_type: "assess" },
        profile_assessment: { change_type: "modified", effective_or_publication_context: "Test context." },
      }],
    }, documents, "workers/thm-001/attempt-1.json", "thm-001-customer-due-diligence");

    expect(audit.workerLevelFailure).toBe(true);
    expect(audit.accepted).toEqual([]);
    expect(audit.rejected).toEqual([expect.objectContaining({ reason_codes: expect.arrayContaining(["record_not_found", "no_verified_evidence"]), escalates_theme_failure: true })]);
  });
});
