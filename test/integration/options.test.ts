import { describe, expect, it } from "vitest";
import { parseRunInput } from "../../src/options.js";

describe("run option controls", () => {
  const base = { profile: "version-change", baseline: "baseline.txt", candidate: "candidate.txt" };

  it("applies the documented defaults", () => {
    const input = parseRunInput(base);
    expect(input).toMatchObject({ maxThemes: 6, concurrency: 2, agentCallBudget: 9, agentTimeoutSeconds: 300, maxSourcePages: 350, maxSourceChars: 2_500_000, dataClassification: "public" });
  });

  it("rejects unsafe approval and classification combinations", () => {
    expect(() => parseRunInput({ ...base, allowPartial: true, autoApprove: true })).toThrow(/cannot be combined/u);
    expect(() => parseRunInput({ ...base, dataClassification: "internal" })).toThrow(/confirm-external-model-access/u);
    expect(() => parseRunInput({ ...base, maxThemes: "7" })).toThrow(/1 to 6/u);
  });
});
