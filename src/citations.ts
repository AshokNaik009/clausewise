import { sha256, canonicalizeExcerpt, canonicalSpan } from "./normalization.js";
import type { CitationClaim, NormalizedDocument, NormalizedRecord } from "./schemas.js";

export interface VerifiedCitation extends CitationClaim {
  page_start: number | null;
  page_end: number | null;
  global_line_start: number;
  global_line_end: number;
  heading_start: string | null;
  heading_end: string | null;
  excerpt_sha256: string;
  verified: true;
}

export interface CitationRejection {
  code: "unknown_document" | "record_not_found" | "record_range_invalid" | "non_canonical_excerpt" | "excerpt_not_in_span";
  message: string;
}

function resolveRecord(document: NormalizedDocument, recordId: string): NormalizedRecord | undefined {
  return document.records.find((record) => record.record_id === recordId);
}

export function verifyCitation(documents: Map<string, NormalizedDocument>, claim: CitationClaim): VerifiedCitation | CitationRejection {
  const document = documents.get(claim.document_id);
  if (!document) return { code: "unknown_document", message: `Unknown document: ${claim.document_id}` };
  const start = resolveRecord(document, claim.start_record_id);
  const end = resolveRecord(document, claim.end_record_id);
  if (!start || !end) return { code: "record_not_found", message: "Citation record does not exist in the claimed document." };
  if (!claim.start_record_id.startsWith(`${claim.document_id}:`) || !claim.end_record_id.startsWith(`${claim.document_id}:`)) {
    return { code: "record_range_invalid", message: "Citation record IDs must belong to the claimed document." };
  }
  const span = canonicalSpan(document.records, claim.start_record_id, claim.end_record_id);
  if (span === null) return { code: "record_range_invalid", message: "Citation range is reversed or invalid." };
  if (canonicalizeExcerpt(claim.excerpt) !== claim.excerpt) {
    return { code: "non_canonical_excerpt", message: "Citation excerpt is not canon-v1 normalized." };
  }
  if (!span.includes(claim.excerpt)) return { code: "excerpt_not_in_span", message: "Citation excerpt is absent from its claimed canonical record span." };
  return {
    ...claim,
    page_start: start.page,
    page_end: end.page,
    global_line_start: start.global_line,
    global_line_end: end.global_line,
    heading_start: start.heading,
    heading_end: end.heading,
    excerpt_sha256: sha256(claim.excerpt),
    verified: true,
  };
}

export function citationFingerprint(citation: VerifiedCitation): string {
  return sha256(`${citation.document_id}\u0000${citation.start_record_id}\u0000${citation.end_record_id}\u0000${citation.excerpt_sha256}`);
}
