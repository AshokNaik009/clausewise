import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildMapperPacket } from "../../src/context.js";
import { deriveApprovedPlan } from "../../src/orchestrator.js";
import { mapperProposalSchema } from "../../src/schemas.js";
import type { NormalizedDocument } from "../../src/schemas.js";

const runOptions = {
  profile: "version-change", dataClassification: "public", maxThemes: 6, concurrency: 2,
  agentCallBudget: 9, agentTimeoutSeconds: 300, maxSourcePages: 350, maxSourceChars: 2_500_000,
  baseline: "", candidate: "", output: "", dryRun: false, autoApprove: false,
} as never;

function syntheticDocument(documentId: "baseline" | "candidate", records: number): NormalizedDocument {
  return {
    schema_version: "1.0", canonicalization_version: "canon-v1", document_id: documentId, format: "md",
    records: Array.from({ length: records }, (_unused, index) => {
      const line = index + 1;
      const text = `Licensed institutions must report suspicious transactions without delay. Paragraph ${line}.`;
      return {
        record_id: `${documentId}:p${String(Math.floor(index / 40) + 1).padStart(4, "0")}:l${String(line).padStart(6, "0")}`,
        ordinal: line, page: Math.floor(index / 40) + 1, page_line: (index % 40) + 1, global_line: line,
        heading: index % 40 === 0 ? `Section ${Math.floor(index / 40) + 1}` : null,
        raw_text: text, canonical_text: text,
        source_order: { page: Math.floor(index / 40) + 1, page_line: (index % 40) + 1 },
      };
    }),
  } as NormalizedDocument;
}

describe("mapper packet stays inside its stated budget", () => {
  it("keeps the serialized packet bounded and coverage honest", () => {
    const documents = [syntheticDocument("baseline", 3_000), syntheticDocument("candidate", 3_000)];
    const packet = buildMapperPacket("version-change", documents);

    expect(Buffer.byteLength(JSON.stringify(packet), "utf8")).toBeLessThanOrEqual(400_000);
    // document_index once carried every record ID and alone exceeded 100 KB.
    expect(Buffer.byteLength(JSON.stringify(packet.document_index), "utf8")).toBeLessThan(50_000);
    expect(packet.coverage.canonical_characters).toBe(
      packet.sampled_records.reduce((total, record) => total + record.canonical_text.length, 0));
  });

  it("omits fields that record_id already encodes", () => {
    const packet = buildMapperPacket("version-change", [syntheticDocument("baseline", 50)]);
    expect(packet.sampled_records[0]).not.toHaveProperty("global_line");
    expect(packet.sampled_records[0]).not.toHaveProperty("ordinal");
    expect(packet.sampled_records[0]).not.toHaveProperty("document_id");
  });
});

describe("near-miss seed record IDs", () => {
  it("recovers unpadded IDs and still rejects invented ones", () => {
    const documents = [syntheticDocument("baseline", 40), syntheticDocument("candidate", 40)];
    const real = documents[0]!.records[7]!.record_id;
    const unpadded = real.replace(/:p0*(\d+):l0*(\d+)$/u, ":p$1:l$2");
    expect(unpadded).not.toBe(real);

    const proposal = mapperProposalSchema.parse({
      schema_version: "1.0",
      proposals: [
        { label: "Recovered theme", description: "d", keywords: ["k"], ranking_rationale: "r", seed_record_ids: [unpadded] },
        { label: "Invented theme", description: "d", keywords: ["k"], ranking_rationale: "r", seed_record_ids: ["baseline:p9999:l999999"] },
      ],
    });
    const { plan } = deriveApprovedPlan("version-change", proposal, documents, 1, "planning/mapper-attempt-1.json", runOptions, 1);

    expect(plan.themes.map((theme) => theme.label)).toEqual(["Recovered theme"]);
    expect(plan.themes[0]?.seed_record_ids).toEqual([real]);
  });
});

const realFixture = "fixtures/cache/str-guidance-2021-vs-2022/sources/normalized";
describe.skipIf(!existsSync(`${realFixture}/baseline.json`))("regression against the CBUAE run that failed", () => {
  it("builds a packet far smaller than the 768,850 bytes the mapper could not answer", async () => {
    const documents = await Promise.all(["baseline", "candidate"].map(async (name) =>
      JSON.parse(await readFile(`${realFixture}/${name}.json`, "utf8")) as NormalizedDocument));
    const packet = buildMapperPacket("version-change", documents);
    expect(Buffer.byteLength(JSON.stringify(packet), "utf8")).toBeLessThan(400_000);
    expect(packet.coverage.canonical_characters).toBe(160_000);
  });
});
