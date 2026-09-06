import { LIMITS } from "./constants.js";
import type { DocumentId, NormalizedDocument, NormalizedRecord } from "./schemas.js";

export interface PacketRecord {
  document_id: DocumentId;
  record_id: string;
  ordinal: number;
  page: number | null;
  global_line: number;
  heading: string | null;
  canonical_text: string;
}

// The mapper only needs an ID it can copy verbatim plus the text to reason over. document_id,
// ordinal, page and global_line are all recoverable from record_id, and at ~2k records their
// JSON overhead dwarfs the text itself, so they are omitted here (theme packets keep them).
export interface MapperPacketRecord {
  record_id: string;
  heading?: string;
  canonical_text: string;
}

interface DocumentIndexEntry {
  document_id: DocumentId;
  structural_unit: string;
  page_start: number | null;
  page_end: number | null;
  global_line_start: number;
  global_line_end: number;
  record_ids: string[];
  record_count: number;
  canonical_character_count: number;
}

export interface MapperPacket {
  schema_version: "1.0";
  kind: "mapper";
  profile: string;
  document_index: DocumentIndexEntry[];
  sampled_records: MapperPacketRecord[];
  coverage: {
    canonical_characters: number;
    source_canonical_characters: number;
    body_sample_ratio: number;
    indexed_structural_units: number;
    detected_structural_units: number;
    context_truncated: boolean;
  };
}

export interface ThemePacket {
  schema_version: "1.0";
  kind: "theme";
  theme: { theme_id: string; label: string; description: string; keywords: string[]; seed_record_ids: string[] };
  records: PacketRecord[];
  coverage: {
    included_record_ids: string[];
    excluded_candidate_record_ids: string[];
    candidate_record_ids: string[];
    per_document: Record<DocumentId, { records: number; canonical_characters: number }>;
    canonical_characters: number;
    approximate_token_estimate: number;
    context_truncated: boolean;
  };
}

function mapperPacketRecord(record: NormalizedRecord): MapperPacketRecord {
  return {
    record_id: record.record_id,
    ...(record.heading ? { heading: record.heading } : {}),
    canonical_text: record.canonical_text,
  };
}

function packetRecord(documentId: DocumentId, record: NormalizedRecord): PacketRecord {
  return {
    document_id: documentId,
    record_id: record.record_id,
    ordinal: record.ordinal,
    page: record.page,
    global_line: record.global_line,
    heading: record.heading,
    canonical_text: record.canonical_text,
  };
}

function recordCharacters(records: Iterable<NormalizedRecord>): number {
  return [...records].reduce((total, record) => total + record.canonical_text.length, 0);
}

function canonicalCharacters(documents: NormalizedDocument[]): number {
  return documents.reduce((total, document) => total + recordCharacters(document.records), 0);
}

function structuralIndex(document: NormalizedDocument): DocumentIndexEntry[] {
  const regions = new Map<string, NormalizedRecord[]>();
  for (const record of document.records) {
    const key = record.heading ? `heading:${record.heading}` : `page:${record.page ?? 0}`;
    const values = regions.get(key) ?? [];
    values.push(record);
    regions.set(key, values);
  }
  return [...regions.entries()].map(([key, records]) => ({
    document_id: document.document_id,
    structural_unit: key.startsWith("heading:") ? key.slice("heading:".length) : `Page ${records[0]?.page ?? 1}`,
    page_start: records[0]?.page ?? null,
    page_end: records.at(-1)?.page ?? null,
    global_line_start: records[0]?.global_line ?? 1,
    global_line_end: records.at(-1)?.global_line ?? 1,
    record_ids: records.slice(0, LIMITS.mapperIndexRecordIds).map((record) => record.record_id),
    record_count: records.length,
    canonical_character_count: recordCharacters(records),
  }));
}

function markerScore(record: NormalizedRecord): number {
  const matches = record.canonical_text.match(/\b(must|shall|required|requirement|obligation|prohibit|maintain|report|record|risk|due diligence|monitor)\b/giu);
  return matches?.length ?? 0;
}

function addWithinLimit(selected: NormalizedRecord[], candidate: NormalizedRecord, maxChars: number, usedCharacters: { value: number }): boolean {
  if (selected.some((record) => record.record_id === candidate.record_id)) return true;
  if (usedCharacters.value + candidate.canonical_text.length > maxChars) return false;
  selected.push(candidate);
  usedCharacters.value += candidate.canonical_text.length;
  return true;
}

// Keeps an even spread across the document rather than truncating to the front, so the mapper
// still sees the shape of the whole instrument when a document has many structural units.
function evenSample<T>(entries: T[], limit: number): T[] {
  if (entries.length <= limit) return entries;
  const step = entries.length / limit;
  return Array.from({ length: limit }, (_unused, index) => entries[Math.floor(index * step)]!);
}

export function buildMapperPacket(profile: string, documents: NormalizedDocument[], maxChars = LIMITS.mapperContextChars): MapperPacket {
  const detectedIndex = documents.flatMap(structuralIndex);
  const documentIndex = evenSample(detectedIndex, LIMITS.mapperIndexEntries);
  const candidates = documents.flatMap((document) => document.records.filter((record) => record.canonical_text));
  const selected: NormalizedRecord[] = [];
  const usedCharacters = { value: 0 };
  const seedRecords = detectedIndex.map((entry) => entry.record_ids[0]).filter((value): value is string => Boolean(value));
  for (const recordId of seedRecords) {
    const record = candidates.find((candidate) => candidate.record_id === recordId);
    if (record) addWithinLimit(selected, record, maxChars, usedCharacters);
  }
  const scored = [...candidates].sort((left, right) => markerScore(right) - markerScore(left) || left.ordinal - right.ordinal);
  for (const record of scored) addWithinLimit(selected, record, maxChars, usedCharacters);
  const sourceChars = canonicalCharacters(documents);
  // The character budget above governs canonical text only; per-record JSON overhead can still
  // push the serialized packet far past it, so trim the sample until the packet itself fits.
  let sampled = selected.map(mapperPacketRecord);
  let sampledCharacters = usedCharacters.value;
  const serializedBytes = (records: MapperPacketRecord[]): number =>
    Buffer.byteLength(JSON.stringify({ document_index: documentIndex, sampled_records: records }), "utf8");
  while (sampled.length > 1 && serializedBytes(sampled) > LIMITS.mapperPacketBytes) {
    const dropped = sampled[sampled.length - 1];
    sampled = sampled.slice(0, -1);
    sampledCharacters -= dropped?.canonical_text.length ?? 0;
  }
  return {
    schema_version: "1.0",
    kind: "mapper",
    profile,
    document_index: documentIndex,
    sampled_records: sampled,
    coverage: {
      canonical_characters: sampledCharacters,
      source_canonical_characters: sourceChars,
      body_sample_ratio: sourceChars === 0 ? 0 : sampledCharacters / sourceChars,
      indexed_structural_units: documentIndex.length,
      detected_structural_units: detectedIndex.length,
      context_truncated: sampled.length < candidates.length,
    },
  };
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function retrievalScore(records: NormalizedRecord[], terms: string[]): Map<string, number> {
  const uniqueTerms = [...new Set(terms.flatMap(tokenize))];
  const documentFrequency = new Map<string, number>();
  const termSets = new Map<string, Set<string>>();
  for (const record of records) {
    const set = new Set(tokenize(record.canonical_text));
    termSets.set(record.record_id, set);
    for (const term of set) if (uniqueTerms.includes(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const scores = new Map<string, number>();
  for (const record of records) {
    const tokens = tokenize(record.canonical_text);
    const tokenSet = termSets.get(record.record_id) ?? new Set<string>();
    const score = uniqueTerms.reduce((sum, term) => {
      if (!tokenSet.has(term)) return sum;
      const frequency = tokens.filter((token) => token === term).length;
      const inverseFrequency = Math.log((records.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      return sum + frequency * inverseFrequency;
    }, 0);
    scores.set(record.record_id, score);
  }
  return scores;
}

function sourceForRecord(documents: NormalizedDocument[], recordId: string): NormalizedDocument | undefined {
  return documents.find((document) => document.records.some((record) => record.record_id === recordId));
}

function regionFor(record: NormalizedRecord): string {
  return record.heading ? `heading:${record.heading}` : `page:${record.page ?? 0}`;
}

export function buildThemePacket(theme: { theme_id: string; label: string; description: string; keywords: string[]; seed_record_ids: string[] }, documents: NormalizedDocument[], maxChars = LIMITS.themeContextChars, maxRecords = LIMITS.themeContextRecords): ThemePacket {
  const records = documents.flatMap((document) => document.records.filter((record) => record.canonical_text));
  const scores = retrievalScore(records, [theme.label, theme.description, ...theme.keywords]);
  const ordered = [...records].sort((left, right) => (scores.get(right.record_id) ?? 0) - (scores.get(left.record_id) ?? 0) || left.ordinal - right.ordinal);
  const selected: NormalizedRecord[] = [];
  const usedCharacters = { value: 0 };
  const perRegion = new Map<string, number>();
  const selectedIds = new Set<string>();
  const add = (record: NormalizedRecord): boolean => {
    if (selectedIds.has(record.record_id)) return true;
    const region = `${record.record_id.startsWith("baseline:") ? "baseline" : "candidate"}:${regionFor(record)}`;
    if ((perRegion.get(region) ?? 0) >= 4) return false;
    if (selected.length >= maxRecords || usedCharacters.value + record.canonical_text.length > maxChars) return false;
    selected.push(record);
    selectedIds.add(record.record_id);
    perRegion.set(region, (perRegion.get(region) ?? 0) + 1);
    usedCharacters.value += record.canonical_text.length;
    return true;
  };
  const addWithNeighborhood = (record: NormalizedRecord): void => {
    const document = sourceForRecord(documents, record.record_id);
    if (!document) return;
    const index = document.records.findIndex((candidate) => candidate.record_id === record.record_id);
    for (let offset = -2; offset <= 2; offset += 1) {
      const neighbor = document.records[index + offset];
      if (neighbor?.canonical_text) add(neighbor);
    }
  };
  for (const seed of theme.seed_record_ids) {
    const document = sourceForRecord(documents, seed);
    const record = document?.records.find((candidate) => candidate.record_id === seed);
    if (record) addWithNeighborhood(record);
  }
  for (const documentId of ["baseline", "candidate"] as const) {
    const available = ordered.filter((record) => record.record_id.startsWith(`${documentId}:`));
    for (const record of available) {
      const selectedFromDocument = selected.filter((candidate) => candidate.record_id.startsWith(`${documentId}:`)).length;
      if (selectedFromDocument >= Math.min(4, available.length) || selected.length >= maxRecords || usedCharacters.value >= maxChars) break;
      addWithNeighborhood(record);
    }
  }
  for (const record of ordered) {
    if (selected.length >= maxRecords || (selected.length > 0 && usedCharacters.value >= maxChars)) break;
    addWithNeighborhood(record);
  }
  const perDocument = {
    baseline: { records: 0, canonical_characters: 0 },
    candidate: { records: 0, canonical_characters: 0 },
  };
  for (const record of selected) {
    const documentId: DocumentId = record.record_id.startsWith("baseline:") ? "baseline" : "candidate";
    perDocument[documentId].records += 1;
    perDocument[documentId].canonical_characters += record.canonical_text.length;
  }
  const selectedRecords = [...selected].sort((left, right) => left.record_id.localeCompare(right.record_id) || left.ordinal - right.ordinal);
  const candidateIds = ordered.map((record) => record.record_id);
  return {
    schema_version: "1.0",
    kind: "theme",
    theme,
    records: selectedRecords.map((record) => packetRecord(record.record_id.startsWith("baseline:") ? "baseline" : "candidate", record)),
    coverage: {
      included_record_ids: selectedRecords.map((record) => record.record_id),
      excluded_candidate_record_ids: candidateIds.filter((recordId) => !selectedIds.has(recordId)),
      candidate_record_ids: candidateIds,
      per_document: perDocument,
      canonical_characters: usedCharacters.value,
      approximate_token_estimate: Math.ceil(usedCharacters.value / 4),
      context_truncated: selectedRecords.length < ordered.length,
    },
  };
}
