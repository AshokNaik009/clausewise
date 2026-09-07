import { Client } from "langsmith";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CodeSettings } from "../config/configuration.js";
import { endpointSchema } from "../config/configuration.js";
import { registerSecret, redactSecrets } from "../config/credentials.js";
import type { SessionContext } from "../persistence/sessions.js";

export class SessionTracing {
  readonly handler: LangChainTracer;
  private readonly client: Client;
  private constructor(private readonly context: SessionContext, private readonly endpoint: string, private readonly project: string, key: string) {
    registerSecret(key);
    this.client = new Client({ apiUrl: endpoint, apiKey: key, timeout_ms: 10_000, debug: false, tracingMode: "langsmith", maxIngestMemoryBytes: 16 * 1024 * 1024, omitTracedRuntimeInfo: true, fetchOptions: { redirect: "error" }, anonymizer: (values) => JSON.parse(JSON.stringify(values, (_name, value: unknown) => typeof value === "string" ? redactSecrets(value) : value)) as Record<string, unknown> });
    this.handler = new LangChainTracer({ client: this.client, projectName: project, tags: ["dcode-ts"], metadata: { session_id: context.info.id } });
  }

  static create(context: SessionContext, settings: CodeSettings): SessionTracing | undefined {
    if (!settings.tracingEnabled) return;
    const endpoint = endpointSchema.parse(settings.tracingEndpoint ?? "https://api.smith.langchain.com");
    const variable = settings.tracingKeyEnv ?? (endpoint === "https://api.smith.langchain.com" ? "LANGSMITH_API_KEY" : "DCODE_TRACING_API_KEY");
    const key = process.env[variable];
    if (!key) throw new Error(`Set ${variable} to use the explicitly enabled tracing service`);
    return new SessionTracing(context, endpoint, settings.tracingProject ?? "dcode-ts", key);
  }

  async begin(): Promise<string> {
    const id = randomUUID();
    await this.context.saveInfo?.({ ...this.context.info, trace: { runId: id, endpoint: this.endpoint, project: this.project } });
    return id;
  }

  async url(): Promise<string> {
    const trace = this.context.info.trace;
    if (!trace) throw new Error("No recorded trace for this session");
    if (trace.endpoint !== this.endpoint) throw new Error("Stored trace belongs to a different tracing endpoint");
    await this.client.flush();
    const url = await this.client.getRunUrl({ runId: trace.runId, projectOpts: { projectName: trace.project } });
    const validated = new URL(z.string().url().parse(url));
    if (!["https:", "http:"].includes(validated.protocol) || validated.username || validated.password) throw new Error("Tracing service returned an invalid browser URL");
    return validated.href;
  }

  async close(): Promise<void> { await this.client.flush(); }
}
