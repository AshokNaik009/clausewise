import { getHarnessProfile } from "deepagents";
import { describe, expect, it, vi } from "vitest";
import { boundedDiagnostic, ModelCallBudgetCallback, structuredOutput } from "../../src/agents.js";

describe("semantic delegate controls", () => {
  it("caps a delegate before reserving an excess provider request", async () => {
    const reserve = vi.fn(async () => undefined);
    const callback = new ModelCallBudgetCallback(reserve, 3);

    await callback.handleChatModelStart();
    await callback.handleChatModelStart();
    await callback.handleChatModelStart();
    await expect(callback.handleChatModelStart()).rejects.toMatchObject({ code: "delegate_call_limit_exhausted" });
    expect(reserve).toHaveBeenCalledTimes(3);
  });

  it("limits worker tools to packet reading, structured output, and optional QuickJS", () => {
    const profile = getHarnessProfile("openai:reg-compare-worker");
    expect([...profile?.excludedTools ?? []]).toEqual(expect.arrayContaining(["ls", "write_file", "edit_file", "delete", "glob", "grep", "execute", "task"]));
    expect(profile?.excludedTools.has("read_file")).toBe(false);
    expect(profile?.generalPurposeSubagent).toMatchObject({ enabled: false });
  });
});

describe("structured output recovery", () => {
  const proposal = { schema_version: "1.0", proposals: [{ label: "L", description: "d", keywords: ["k"], ranking_rationale: "r", seed_record_ids: ["baseline:p0001:l000001"] }] };

  it("prefers a real structured response when the model tool-calls correctly", () => {
    expect(structuredOutput({ structuredResponse: proposal, messages: [] })).toEqual(proposal);
  });

  it("recovers JSON a weak model returned as fenced prose instead of a tool call", () => {
    const state = { messages: [{ content: "Here is the plan:\n```json\n" + JSON.stringify(proposal) + "\n```" }] };
    expect(structuredOutput(state)).toEqual(proposal);
  });

  it("recovers unfenced JSON and ignores trailing commentary", () => {
    const state = { messages: [{ content: `Result: ${JSON.stringify(proposal)} — let me know if you need more.` }] };
    expect(structuredOutput(state)).toEqual(proposal);
  });

  it("still fails when the output is not JSON at all", () => {
    expect(() => structuredOutput({ messages: [{ content: "I could not complete this." }] }))
      .toThrowError(expect.objectContaining({ code: "schema_invalid" }));
  });
});

describe("diagnostic capture", () => {
  it("redacts credentials and flags truncation", () => {
    expect(boundedDiagnostic("failed with sk-or-v1-abcdef0123456789 token").text).not.toContain("abcdef0123456789");
    expect(boundedDiagnostic("short").truncated).toBe(false);
    expect(boundedDiagnostic("x".repeat(2_000_000)).truncated).toBe(true);
  });
});
