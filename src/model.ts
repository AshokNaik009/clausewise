import { ChatOpenAI } from "@langchain/openai";
import { RegCompareError } from "./errors.js";
import type { ModelProvenance } from "./workspace.js";

const defaultModel = "deepseek/deepseek-chat";
const defaultBaseUrl = "https://openrouter.ai/api/v1";

function providerOrder(): string[] {
  return (process.env.REG_COMPARE_PROVIDER_ORDER ?? "").split(",").map((provider) => provider.trim()).filter(Boolean);
}

export function modelConfiguration(): ModelProvenance {
  const order = providerOrder();
  if (!order.length) throw new RegCompareError("provider_order_required", "REG_COMPARE_PROVIDER_ORDER must name the approved inference provider for reproducible runs.", 2);
  return {
    model: process.env.REG_COMPARE_MODEL ?? defaultModel,
    base_url: process.env.REG_COMPARE_BASE_URL ?? defaultBaseUrl,
    temperature: 0,
    provider_order: order,
    allow_fallbacks: false,
    data_collection: "deny",
  };
}

export function assertExternalModelConfigured(): ModelProvenance {
  if (!process.env.REG_COMPARE_API_KEY && !process.env.OPENROUTER_API_KEY) throw new RegCompareError("openrouter_key_missing", "OPENROUTER_API_KEY is required to invoke the comparison model.", 2);
  return modelConfiguration();
}

export function createOpenRouterModel(options: { timeoutSeconds?: number } = {}): ChatOpenAI {
  const apiKey = process.env.REG_COMPARE_API_KEY ?? process.env.OPENROUTER_API_KEY!;
  const configuration = assertExternalModelConfigured();
  const timeout = options.timeoutSeconds ? options.timeoutSeconds * 1_000 : null;
  return new ChatOpenAI({
    model: configuration.model,
    apiKey,
    configuration: { baseURL: configuration.base_url },
    temperature: configuration.temperature,
    maxRetries: 0,
    ...(configuration.base_url.includes("openrouter.ai") ? { modelKwargs: { provider: { order: configuration.provider_order, allow_fallbacks: false, data_collection: "deny" } } } : {}),
    ...(timeout ? { timeout } : {}),
  });
}
