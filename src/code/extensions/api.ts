import { randomUUID } from "node:crypto";
import { tool, type StructuredTool } from "@langchain/core/tools";
import type { AgentMiddleware } from "langchain";
import type { AnyBackendProtocol } from "deepagents";
import { z } from "zod";
import { agentSchema, type ExtensionModule } from "./config.js";
import { errorText } from "../shared/output.js";

export interface ExtensionTool {
  name: string;
  description: string;
  schema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  invoke: (input: Record<string, unknown>, context: { signal: AbortSignal }) => unknown | Promise<unknown>;
}
export interface ExtensionApi {
  readonly apiVersion: 1;
  readonly cwd: string;
  readonly path: string;
  readonly signal: AbortSignal;
  registerTool: (definition: ExtensionTool) => void;
  registerMiddleware: (middleware: AgentMiddleware) => void;
  registerBackendRoute: (prefix: string, backend: AnyBackendProtocol) => void;
  registerAgent: (agent: z.input<typeof agentSchema>) => void;
  registerSkills: (paths: string[]) => void;
  onShutdown: (callback: () => void | Promise<void>) => void;
}
export interface ExtensionRegistration {
  name: string; version: string; path: string; tools: StructuredTool[]; middleware: AgentMiddleware[];
  routes: Record<string, AnyBackendProtocol>; agents: z.infer<typeof agentSchema>[]; skills: string[];
}

export class NativeExtensions {
  readonly registrations: ExtensionRegistration[] = [];
  requiresRebuild = false;
  private readonly lifetime = new AbortController();
  private readonly cleanup: (() => void | Promise<void>)[] = [];
  private closed = false;

  async load(modules: ExtensionModule[], cwd: string, diagnostics: string[]): Promise<void> {
    for (const source of modules) {
      const registration: ExtensionRegistration = { name: source.name, version: source.version, path: source.path, tools: [], middleware: [], routes: {}, agents: [], skills: [] };
      const cleanup: (() => void | Promise<void>)[] = [];
      let registering = true;
      let revoked = false;
      const assertOpen = (rebuild = false) => {
        if (revoked || this.closed) throw new Error("Extension registration was revoked or the session is closed");
        if (rebuild && !registering) this.requiresRebuild = true;
      };
      const api: ExtensionApi = Object.freeze({
        apiVersion: 1, cwd, path: source.path, signal: this.lifetime.signal,
        registerTool: (definition: ExtensionTool) => {
          assertOpen();
          z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u).parse(definition.name);
          z.string().min(1).max(8000).parse(definition.description);
          if (definition.schema.type !== "object" || JSON.stringify(definition.schema).length > 64_000 || typeof definition.invoke !== "function") throw new Error("Invalid extension tool");
          const reserved = ["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute", "task", "write_todos", "session_context", "read_skill", "update_goal", "web_search", "fetch_url"];
          if (reserved.includes(definition.name) || registration.tools.length >= 50 || registration.tools.some((entry) => entry.name === definition.name) || this.registrations.some((entry) => entry !== registration && entry.tools.some((tool) => tool.name === definition.name))) throw new Error("Duplicate, reserved, or excessive extension tools");
          registration.tools.push(tool(async (input, runtime) => {
            const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000), ...(runtime.signal ? [runtime.signal] : [])]);
            const result = await bounded(Promise.resolve(definition.invoke(z.record(z.string(), z.unknown()).parse(input), { signal })), signal);
            const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
            if (Buffer.byteLength(text) > 1_000_000) throw new Error("Extension tool output exceeds 1 MB");
            return text;
          }, { name: definition.name, description: definition.description, schema: definition.schema }));
        },
        registerMiddleware: (middleware: AgentMiddleware) => {
          assertOpen(true);
          if (!middleware || !/^[A-Za-z][\w-]{0,63}$/u.test(middleware.name) || registration.middleware.length >= 20) throw new Error("Invalid extension middleware");
          registration.middleware.push(middleware);
        },
        registerBackendRoute: (prefix: string, backend: AnyBackendProtocol) => {
          assertOpen(true);
          if (!/^\/(?:[a-z][a-z0-9_-]*\/)+$/u.test(prefix) || ["/artifacts/", "/conversation_history/", "/memories/internal/"].some((reserved) => reserved.startsWith(prefix) || prefix.startsWith(reserved))) throw new Error("Invalid or reserved backend route");
          if (!backend || typeof backend.read !== "function" || Object.keys(registration.routes).some((route) => route.startsWith(prefix) || prefix.startsWith(route))) throw new Error("Invalid or overlapping backend route");
          registration.routes[prefix] = backend;
        },
        registerAgent: (agent: z.input<typeof agentSchema>) => { assertOpen(true); if (registration.agents.length >= 20 || registration.agents.some(({ name }) => name === agent.name)) throw new Error("Duplicate or excessive registered agents"); registration.agents.push(agentSchema.parse(agent)); },
        registerSkills: (paths: string[]) => { assertOpen(true); if (registration.skills.length + paths.length > 20) throw new Error("Too many registered skill roots"); registration.skills.push(...z.array(z.string().regex(/^\/(?!.*\.\.)[^\\]+$/u)).max(20).parse(paths)); },
        onShutdown: (callback: () => void | Promise<void>) => { assertOpen(); if (typeof callback !== "function") throw new Error("Shutdown callback must be callable"); (registering ? cleanup : this.cleanup).push(callback); },
      });
      try {
        const module: unknown = await bounded(import(`data:text/javascript;base64,${Buffer.from(source.code).toString("base64")}#${randomUUID()}`), AbortSignal.timeout(30_000));
        if (!module || typeof module !== "object" || !("extension" in module) || typeof module.extension !== "function") throw new Error("Plugin must export an extension(api) setup function");
        await bounded(Promise.resolve(module.extension(api)), AbortSignal.timeout(30_000));
        this.registrations.push(registration);
        this.cleanup.push(...cleanup);
      } catch (error) {
        revoked = true;
        diagnostics.push(`Extension ${source.name} setup rolled back: ${errorText(error)}`);
        for (const close of cleanup.reverse()) await bounded(Promise.resolve().then(close), AbortSignal.timeout(10_000)).catch(() => undefined);
      } finally { registering = false; }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const close of this.cleanup.splice(0).reverse()) await bounded(Promise.resolve().then(close), AbortSignal.timeout(10_000)).catch(() => undefined);
  }
}

export async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
