import { createHash } from "node:crypto";
import type { DocumentId, NormalizedDocument, NormalizedRecord, SourceFormat } from "./schemas.js";

export const CANONICALIZATION_VERSION = "canon-v1" as const;

export function canonicalizeLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/gu, "")
    .replace(/\r\n?|\n/gu, "\n")
    .replace(/[^\S\r\n]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

export function canonicalizeExcerpt(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/gu, "")
    .replace(/\r\n?|\n/gu, "\n")
    .split("\n")
    .map(canonicalizeLine)
    .join("\n");
}

function headingFor(line: string, prior: string | null): string | null {
  if (/^#{1,6}\s+\S/u.test(line)) return line.replace(/^#{1,6}\s+/u, "");
  if (/^(?:\d+(?:\.\d+)*[.)]?\s+)?[A-Z][A-Z\s,&/-]{4,}$/u.test(line)) return line;
  return prior;
}

function recordId(documentId: DocumentId, page: number | null, sourceLine: number): string {
  return `${documentId}:p${String(page ?? 0).padStart(4, "0")}:l${String(sourceLine).padStart(6, "0")}`;
}

export function normalizePages(documentId: DocumentId, format: SourceFormat, pages: string[]): NormalizedDocument {
  const records: NormalizedRecord[] = [];
  let ordinal = 0;
  let heading: string | null = null;
  for (const [pageIndex, pageText] of pages.entries()) {
    const page = format === "pdf" ? pageIndex + 1 : null;
    const lines = pageText.replace(/\r\n?/gu, "\n").split("\n");
    for (const [lineIndex, rawText] of lines.entries()) {
      const canonicalText = canonicalizeLine(rawText);
      if (canonicalText) heading = headingFor(canonicalText, heading);
      ordinal += 1;
      const pageLine = format === "pdf" ? lineIndex + 1 : null;
      const sourceLine = pageLine ?? ordinal;
      records.push({
        record_id: recordId(documentId, page, sourceLine),
        ordinal,
        page,
        page_line: pageLine,
        global_line: ordinal,
        heading,
        raw_text: rawText,
        canonical_text: canonicalText,
        source_order: { page, page_line: pageLine },
      });
    }
  }
  return { schema_version: "1.0", canonicalization_version: CANONICALIZATION_VERSION, document_id: documentId, format, records };
}

export function canonicalSpan(records: NormalizedRecord[], startId: string, endId: string): string | null {
  const start = records.findIndex((record) => record.record_id === startId);
  const end = records.findIndex((record) => record.record_id === endId);
  if (start < 0 || end < start) return null;
  return records.slice(start, end + 1).map((record) => record.canonical_text).join("\n");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
