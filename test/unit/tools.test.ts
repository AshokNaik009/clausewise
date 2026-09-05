import { describe, expect, it } from "vitest";
import { createHarnessTools } from "../../src/tools.js";

describe("shell harness tools", () => {
  it("returns source metadata without exposing raw source text", async () => {
    const activities: string[] = [];
    const inspectSources = createHarnessTools({ onActivity: (message) => activities.push(message) }).find((tool) => tool.name === "inspect_sources");
    if (!inspectSources) throw new Error("inspect_sources tool is unavailable");
    const output = JSON.parse(await inspectSources.invoke({ paths: ["test/fixtures/baseline.txt"] })) as { sources: Record<string, unknown>[] };
    expect(output.sources).toEqual([expect.objectContaining({ path: "test/fixtures/baseline.txt", format: "text" })]);
    expect(output.sources[0]).not.toHaveProperty("preview");
    expect(JSON.stringify(output)).not.toContain("CUSTOMER DUE DILIGENCE");
    expect(activities).toEqual(["Searching local source metadata"]);
  });

  it("discovers supported sources in a nested cache directory", async () => {
    const inspectSources = createHarnessTools().find((tool) => tool.name === "inspect_sources");
    if (!inspectSources) throw new Error("inspect_sources tool is unavailable");
    const output = JSON.parse(await inspectSources.invoke({ query: "cached-guidance" })) as { sources: Record<string, unknown>[] };
    expect(output.sources).toEqual([expect.objectContaining({ path: "test/fixtures/cache/cached-guidance.pdf", format: "pdf" })]);
  });

  it("returns a safe structured error for an unavailable source", async () => {
    const inspectSources = createHarnessTools().find((tool) => tool.name === "inspect_sources");
    if (!inspectSources) throw new Error("inspect_sources tool is unavailable");
    const output = JSON.parse(await inspectSources.invoke({ paths: ["test/fixtures/missing.txt"] })) as { error: { code: string; message: string } };
    expect(output.error).toMatchObject({ code: "invalid_source" });
    expect(output.error.message).toMatch(/does not exist/u);
  });

  it("rejects every source-preview request", async () => {
    const inspectSources = createHarnessTools().find((tool) => tool.name === "inspect_sources");
    if (!inspectSources) throw new Error("inspect_sources tool is unavailable");
    await expect(inspectSources.invoke({ paths: ["test/fixtures/baseline.txt"], preview_chars: 0 })).rejects.toThrow();
  });
});
