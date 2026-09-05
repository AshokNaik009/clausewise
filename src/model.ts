import { ChatOpenAI } from "@langchain/openai";
import { RegCompareError } from "./errors.js";

const defaultModel = "deepseek/deepseek-chat";
const defaultBaseUrl = "https://openrouter.ai/api/v1";

export function createOpenRouterModel(options: { timeoutSeconds?: number } = {}): ChatOpenAI {
  const apiKey = process.env.REG_COMPARE_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new RegCompareError("openrouter_key_missing", "OPENROUTER_API_KEY is required to invoke the comparison model.", 2);
  const timeout = options.timeoutSeconds ? options.timeoutSeconds * 1_000 : null;
  return new ChatOpenAI({
    model: process.env.REG_COMPARE_MODEL ?? defaultModel,
    apiKey,
    configuration: { baseURL: process.env.REG_COMPARE_BASE_URL ?? defaultBaseUrl },
    temperature: 0,
    maxRetries: 0,
    ...(timeout ? { timeout } : {}),
  });
}

export function modelConfiguration(): { model: string; base_url: string; api_key_configured: boolean } {
  return {
    model: process.env.REG_COMPARE_MODEL ?? defaultModel,
    base_url: process.env.REG_COMPARE_BASE_URL ?? defaultBaseUrl,
    api_key_configured: Boolean(process.env.REG_COMPARE_API_KEY ?? process.env.OPENROUTER_API_KEY),
  };
}
