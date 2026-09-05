import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/preflight.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("doctor", () => {
  it("performs local checks without a network request by default", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await doctor();
    expect(fetch).not.toHaveBeenCalled();
    expect(result.checks.openrouter_reachable).toMatchObject({ ok: true, required: false });
  });
});
