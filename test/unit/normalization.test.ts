import { describe, expect, it } from "vitest";
import { canonicalizeExcerpt, canonicalizeLine, normalizePages } from "../../src/normalization.js";

describe("canon-v1", () => {
  it("normalizes only specified Unicode and whitespace behavior", () => {
    expect(canonicalizeLine("  A\u00ad\u200b\tB\r\n")).toBe("A B\n");
    expect(canonicalizeExcerpt(" A\tB\r\n C\u00adD ")).toBe("A B\nCD");
  });

  it("preserves source record boundaries and stable locators", () => {
    const normalized = normalizePages("baseline", "pdf", ["TITLE\nfirst", "second"]);
    expect(normalized.records.map((record) => record.record_id)).toEqual([
      "baseline:p0001:l000001",
      "baseline:p0001:l000002",
      "baseline:p0002:l000001",
    ]);
    expect(normalized.records.map((record) => record.global_line)).toEqual([1, 2, 3]);
    expect(normalized.records[1]?.heading).toBe("TITLE");
  });
});
