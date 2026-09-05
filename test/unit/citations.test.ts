import { describe, expect, it } from "vitest";
import { verifyCitation } from "../../src/citations.js";
import { normalizePages } from "../../src/normalization.js";

describe("citation audit", () => {
  const baseline = normalizePages("baseline", "text", ["Customer due diligence is required.\nRecords must be retained."]);

  it("derives a verified citation from a canonical contiguous span", () => {
    const result = verifyCitation(new Map([["baseline", baseline]]), {
      document_id: "baseline",
      start_record_id: "baseline:p0000:l000001",
      end_record_id: "baseline:p0000:l000002",
      excerpt: "Customer due diligence is required.\nRecords must be retained.",
    });
    expect("verified" in result && result.verified).toBe(true);
    expect("excerpt_sha256" in result && result.excerpt_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a cross-document record range", () => {
    const result = verifyCitation(new Map([["baseline", baseline]]), {
      document_id: "baseline",
      start_record_id: "candidate:p0000:l000001",
      end_record_id: "candidate:p0000:l000001",
      excerpt: "Customer",
    });
    expect(result).toMatchObject({ code: "record_not_found" });
  });

  it("rejects an excerpt that is not already canonical", () => {
    const result = verifyCitation(new Map([["baseline", baseline]]), {
      document_id: "baseline",
      start_record_id: "baseline:p0000:l000001",
      end_record_id: "baseline:p0000:l000001",
      excerpt: "Customer  due diligence",
    });
    expect(result).toMatchObject({ code: "non_canonical_excerpt" });
  });
});
