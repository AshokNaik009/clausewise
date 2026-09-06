import { sha256, canonicalizeExcerpt, canonicalSpan } from "./normalization.js";
import type { CitationClaim, NormalizedDocument, NormalizedRecord } from "./schemas.js";

const MAX_EXCERPT_CHARACTERS = 4_000;

export interface VerifiedCitation extends CitationClaim {
  excerpt: string;
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
  code: "unknown_document" | "record_not_found" | "record_range_invalid" | "record_range_too_broad";
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
  // The excerpt is derived from the stored source rather than matched against the model's
  // transcription. Exact matching demanded that a model reproduce the newline this harness
  // inserts between records, which no model does reliably; deriving it makes the quoted text
  // correct by construction and keeps the locator the only thing the model must get right.
  const excerpt = canonicalizeExcerpt(span);
  if (!excerpt) return { code: "record_range_invalid", message: "Citation range resolves to empty source text." };
  if (excerpt.length > MAX_EXCERPT_CHARACTERS) {
    return { code: "record_range_too_broad", message: `Citation range spans ${excerpt.length} characters; cite a range within ${MAX_EXCERPT_CHARACTERS}.` };
  }
  return {
    ...claim,
    excerpt,
    page_start: start.page,
    page_end: end.page,
    global_line_start: start.global_line,
    global_line_end: end.global_line,
    heading_start: start.heading,
    heading_end: end.heading,
    excerpt_sha256: sha256(excerpt),
    verified: true,
  };
}

export function citationFingerprint(citation: VerifiedCitation): string {
  return sha256(`${citation.document_id}\u0000${citation.start_record_id}\u0000${citation.end_record_id}\u0000${citation.excerpt_sha256}`);
}
