import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterModel, modelConfiguration } from "../../src/model.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenRouter model configuration", () => {
  it("forwards pinned provider routing and data-collection controls in every request", () => {
    vi.stubEnv("REG_COMPARE_API_KEY", "test-key");
    vi.stubEnv("REG_COMPARE_PROVIDER_ORDER", "approved-primary, approved-secondary");
    vi.stubEnv("REG_COMPARE_BASE_URL", "https://openrouter.ai/api/v1");
    const model = createOpenRouterModel();

    expect(modelConfiguration()).toMatchObject({ model: "deepseek/deepseek-chat", temperature: 0, provider_order: ["approved-primary", "approved-secondary"], allow_fallbacks: false, data_collection: "deny" });
    expect(model.invocationParams()).toMatchObject({
      model: "deepseek/deepseek-chat",
      temperature: 0,
      provider: { order: ["approved-primary", "approved-secondary"], allow_fallbacks: false, data_collection: "deny" },
    });
  });
});
