import { describe, expect, it } from "vitest";
import { buildMapperPacket, buildThemePacket } from "../../src/context.js";
import { normalizePages } from "../../src/normalization.js";

function document(id: "baseline" | "candidate") {
  return normalizePages(id, "text", ["CUSTOMER DUE DILIGENCE\nCustomer due diligence is required for every customer.\nRecords must be maintained for five years.\nREPORTING\nA report must be submitted promptly."]);
}

describe("bounded context packets", () => {
  it("indexes all structural units while bounding mapper content", () => {
    const packet = buildMapperPacket("version-change", [document("baseline"), document("candidate")], 80);
    expect(packet.document_index.length).toBeGreaterThanOrEqual(2);
    expect(packet.coverage.canonical_characters).toBeLessThanOrEqual(80);
  });

  it("retrieves bounded theme evidence from both documents", () => {
    const packet = buildThemePacket({
      theme_id: "thm-001-customer-due-diligence",
      label: "Customer due diligence",
      description: "CDD requirements",
      keywords: ["customer", "due", "diligence"],
      seed_record_ids: ["baseline:p0000:l000002", "candidate:p0000:l000002"],
    }, [document("baseline"), document("candidate")], 500, 8);
    expect(packet.coverage.canonical_characters).toBeLessThanOrEqual(500);
    expect(new Set(packet.records.map((record) => record.document_id))).toEqual(new Set(["baseline", "candidate"]));
    expect(packet.records.length).toBeLessThanOrEqual(8);
  });
});
