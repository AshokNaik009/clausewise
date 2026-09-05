import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { RegCompareError, assert } from "./errors.js";
import { normalizePages, sha256 } from "./normalization.js";
import type { DocumentId, DocumentRef, NormalizedDocument, SourceFormat } from "./schemas.js";

export interface IngestedDocument {
  ref: DocumentRef;
  normalized: NormalizedDocument;
  source: Buffer;
  sourceStats: {
    document_id: DocumentId;
    page_count: number;
    record_count: number;
    canonical_character_count: number;
    textual_page_count: number;
    textual_page_ratio: number;
    script_ratios: { latin: number; arabic: number };
    extraction_order: "parser-page-order" | "physical-line-order";
    quality_gate: "accepted";
  };
}

function detectFormat(path: string): SourceFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".md") return "markdown";
  if (extension === ".txt") return "text";
  throw new RegCompareError("unsupported_format", `Unsupported source format: ${extension || "no extension"}`, 1);
}

function strictUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new RegCompareError("invalid_utf8", "Text and Markdown inputs must be valid UTF-8.", 2);
  }
}

async function extractPdfPages(source: Buffer): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(source) });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

function calculateScriptRatios(value: string): { latin: number; arabic: number } {
  const alphabetic = [...value].filter((character) => /\p{L}/u.test(character)).slice(0, 20_000);
  if (!alphabetic.length) return { latin: 0, arabic: 0 };
  const latin = alphabetic.filter((character) => /\p{Script=Latin}/u.test(character)).length / alphabetic.length;
  const arabic = alphabetic.filter((character) => /\p{Script=Arabic}/u.test(character)).length / alphabetic.length;
  return { latin, arabic };
}

function validateTextQuality(normalized: NormalizedDocument, format: SourceFormat, sourcePageCount: number, maxPages: number, maxChars: number): { totalChars: number; textualPages: number; ratios: { latin: number; arabic: number } } {
  assert(sourcePageCount <= maxPages, "source_too_large", `Source exceeds the ${maxPages}-page limit.`);
  const pages = new Map<number, number>();
  for (const record of normalized.records) {
    const page = record.page ?? 1;
    pages.set(page, (pages.get(page) ?? 0) + record.canonical_text.replace(/\s/gu, "").length);
  }
  const totalChars = normalized.records.map((record) => record.canonical_text).join("\n").length;
  assert(totalChars <= maxChars, "source_too_large", `Source exceeds the ${maxChars}-character limit.`);
  const textualPages = [...pages.values()].filter((count) => count >= 100).length;
  const minimumChars = Math.max(1_000, 200 * sourcePageCount);
  if (format === "pdf" && (totalChars < minimumChars || textualPages / sourcePageCount < 0.8)) {
    throw new RegCompareError("needs_ocr", "PDF extraction is too sparse for evidence-backed analysis. Provide an OCRed PDF or approved transcription.", 2);
  }
  const ratios = calculateScriptRatios(normalized.records.map((record) => record.canonical_text).join("\n"));
  if (ratios.arabic > 0.01 || ratios.latin < 0.7) {
    throw new RegCompareError("unsupported_language", "Only English-language documents are supported in this release.", 2);
  }
  return { totalChars, textualPages, ratios };
}

export async function ingestDocument(documentId: DocumentId, path: string, limits: { maxPages: number; maxChars: number }): Promise<IngestedDocument> {
  const sourceInfo = await stat(path).catch(() => null);
  assert(sourceInfo?.isFile(), "invalid_source", `Source file does not exist or is not a regular file: ${path}`);
  const format = detectFormat(path);
  const source = await readFile(path);
  const pages = format === "pdf" ? await extractPdfPages(source) : [strictUtf8(source)];
  const normalized = normalizePages(documentId, format, pages);
  const quality = validateTextQuality(normalized, format, pages.length, limits.maxPages, limits.maxChars);
  const rawPath = `sources/raw/${documentId}${extname(path).toLowerCase()}`;
  const normalizedPath = `sources/normalized/${documentId}.json`;
  return {
    source,
    normalized,
    ref: {
      document_id: documentId,
      display_name: basename(path),
      format,
      language: "en",
      raw_artifact_path: rawPath,
      normalized_artifact_path: normalizedPath,
      sha256: sha256(source),
      page_count: pages.length,
      record_count: normalized.records.length,
      canonicalization_version: "canon-v1",
    },
    sourceStats: {
      document_id: documentId,
      page_count: pages.length,
      record_count: normalized.records.length,
      canonical_character_count: quality.totalChars,
      textual_page_count: quality.textualPages,
      textual_page_ratio: quality.textualPages / pages.length,
      script_ratios: quality.ratios,
      extraction_order: format === "pdf" ? "parser-page-order" : "physical-line-order",
      quality_gate: "accepted",
    },
  };
}
