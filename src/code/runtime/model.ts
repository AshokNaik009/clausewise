import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CredentialStore } from "../config/credentials.js";
import type { CodeSettings, ProviderDefinition } from "../config/configuration.js";

export interface ModelOptions {
  model?: string;
  baseUrl?: string;
}

export function modelSettings(options: ModelOptions, env: NodeJS.ProcessEnv = process.env) {
  const model = options.model ?? env.DCODE_MODEL;
  if (!model?.trim()) throw new Error("Choose a model with --model or DCODE_MODEL");
  const baseUrl = options.baseUrl ?? env.DCODE_BASE_URL;
  if (baseUrl) {
    const url = new URL(baseUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
      throw new Error("Model endpoints require HTTPS (HTTP is allowed on loopback) and no embedded credentials, query, or fragment");
    }
  }
  const apiKey = env.DCODE_API_KEY ?? (baseUrl ? undefined : env.OPENAI_API_KEY);
  if (!apiKey) throw new Error(baseUrl ? "Set DCODE_API_KEY for the custom model endpoint" : "Set DCODE_API_KEY or OPENAI_API_KEY");
  return { model, apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

export async function createCodeModel(options: ModelOptions, provider?: { name: string; definition: ProviderDefinition; settings: CodeSettings }): Promise<BaseChatModel> {
  const settings = provider ? {
    model: options.model!, baseUrl: provider.definition.endpoint,
    apiKey: (await new CredentialStore().resolve(provider.name, provider.definition)).key,
  } : modelSettings(options);
  if (provider && !provider.definition.toolCalling) throw new Error("The coding runtime requires a tool-calling provider");
  const { ChatOpenAI } = await import("@langchain/openai");
  return new ChatOpenAI({
    model: settings.model,
    apiKey: settings.apiKey,
    streaming: provider?.definition.streaming ?? true,
    timeout: (provider?.settings.timeoutSeconds ?? 120) * 1000,
    maxRetries: provider?.settings.maxRetries ?? 2,
    ...(provider?.settings.reasoningEffort ? { reasoningEffort: provider.settings.reasoningEffort } : {}),
    configuration: { baseURL: settings.baseUrl ?? "https://api.openai.com/v1" },
  });
}
