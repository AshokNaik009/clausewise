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

  it("ignores a model-supplied excerpt and quotes the source itself", () => {
    // The model transcribed the span with doubled spacing and a joining semicolon — the shape
    // that previously failed exact matching and sank every finding in a real run.
    const result = verifyCitation(new Map([["baseline", baseline]]), {
      document_id: "baseline",
      start_record_id: "baseline:p0000:l000001",
      end_record_id: "baseline:p0000:l000002",
      excerpt: "Customer  due diligence is required.; Records must be retained.",
    });
    expect("verified" in result && result.verified).toBe(true);
    expect("excerpt" in result && result.excerpt).toBe("Customer due diligence is required.\nRecords must be retained.");
  });

  it("verifies a citation that supplies no excerpt at all", () => {
    const result = verifyCitation(new Map([["baseline", baseline]]), {
      document_id: "baseline",
      start_record_id: "baseline:p0000:l000001",
      end_record_id: "baseline:p0000:l000001",
    });
    expect("verified" in result && result.verified).toBe(true);
    expect("excerpt" in result && result.excerpt).toBe("Customer due diligence is required.");
  });

});
