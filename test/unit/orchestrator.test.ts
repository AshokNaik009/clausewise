import { describe, expect, it } from "vitest";
import { normalizePages } from "../../src/normalization.js";
import { parseRunInput } from "../../src/options.js";
import { deriveApprovedPlan } from "../../src/orchestrator.js";

describe("analysis call allocation", () => {
  it("reserves two remaining provider requests for every planned theme", () => {
    const documents = [
      normalizePages("baseline", "text", ["Customer due diligence is required.\nSuspicious activity must be reported."]),
      normalizePages("candidate", "text", ["Customer due diligence is required.\nSuspicious activity must be reported."]),
    ];
    const seedRecordIds = documents.map((document) => document.records[0]!.record_id);
    const input = parseRunInput({ profile: "version-change", baseline: "baseline.txt", candidate: "candidate.txt", agentCallBudget: 9, maxThemes: 6 });
    const proposal = {
      schema_version: "1.0",
      proposals: ["Customer due diligence", "Suspicious activity reports", "Record keeping", "Screening"].map((label) => ({
        label,
        description: `Compare ${label}.`,
        keywords: label.split(" "),
        ranking_rationale: "The documents cover this obligation.",
        seed_record_ids: seedRecordIds,
      })),
    };

    const { plan } = deriveApprovedPlan("version-change", proposal, documents, 1, "planning/mapper-result-1.json", input, 3);
    expect(plan.call_budget).toEqual({ used: 3, remaining: 6, maximum_remaining: 6 });
    expect(plan.themes).toHaveLength(3);
  });
});
