import { createMiddleware } from "langchain";
import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { CompositeBackend, type AnyBackendProtocol } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import { webTools } from "../tools/web.js";
import { searchTool } from "../tools/search.js";
import type { CodeSettings } from "../config/configuration.js";
import { loadExtensions, type ExtensionConfiguration } from "./config.js";
import { McpConnections } from "./mcp.js";
import { HookRunner } from "./hooks.js";
import { NativeExtensions } from "./api.js";
import { errorText, messageText } from "../shared/output.js";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { decisionSchema } from "../runtime/approvals.js";

export class ExtensionHost {
  readonly mcp = new McpConnections();
  readonly native = new NativeExtensions();
  readonly hooks: HookRunner;
  readonly tools: StructuredTool[] = [];
  private readonly observed = new Map<string, { name: string; description: string }>();
  private context = "";
  private sessionId = "";

  private constructor(readonly configuration: ExtensionConfiguration, cwd: string) {
    this.hooks = new HookRunner(configuration.hooks, cwd, configuration.diagnostics);
  }

  static async create(cwd: string, trusted: boolean, projectContext: boolean, settings: CodeSettings = {}, overrides: Record<string, boolean> = {}): Promise<ExtensionHost> {
    const configuration = await loadExtensions(cwd, trusted, projectContext);
    for (const [name, enabled] of Object.entries(overrides)) if (configuration.mcp[name]) configuration.mcp[name].disabled = !enabled;
    const host = new ExtensionHost(configuration, cwd);
    try {
      if (settings.extensionsEnabled !== false) await host.native.load(configuration.modules, cwd, configuration.diagnostics);
      for (const registration of host.native.registrations) {
        for (const agent of registration.agents) {
          if (configuration.agents.some(({ name }) => name === agent.name)) throw new Error(`Duplicate custom agent: ${agent.name}`);
          configuration.agents.push(agent);
        }
      }
      await host.mcp.connect(configuration.mcp, cwd);
      host.configureWeb(settings);
      return host;
    } catch (error) { await host.close(); throw error; }
  }

  async start(sessionId: string, cause: string): Promise<void> {
    this.sessionId = sessionId;
    const result = await this.hooks.guard("SessionStart", { session_id: sessionId, cause });
    this.context = result.context.join("\n");
  }

  configureWeb(settings: CodeSettings): void {
    const native = this.native.registrations.flatMap((entry) => entry.tools);
    const reserved = new Set(["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute", "task", "write_todos", "session_context", "update_goal", "web_search", "fetch_url"]);
    for (const tool of native) {
      if (reserved.has(tool.name)) throw new Error(`Extension tool collides with an existing tool: ${tool.name}`);
      reserved.add(tool.name);
    }
    this.tools.splice(0, this.tools.length, ...this.mcp.tools, ...native, ...(settings.webFetch === true ? webTools() : []));
    if (settings.webSearch === true && process.env.TAVILY_API_KEY) this.tools.push(searchTool());
    if (settings.webSearch === true && !process.env.TAVILY_API_KEY) this.configuration.diagnostics.push("Web search was enabled but TAVILY_API_KEY is missing; the tool is not exposed.");
    if (new Set(this.tools.map(({ name }) => name)).size !== this.tools.length) throw new Error("Integration tool name collision");
    this.observed.clear();
  }

  backend(fallback: AnyBackendProtocol): AnyBackendProtocol {
    const routes: Record<string, AnyBackendProtocol> = {};
    for (const registration of this.native.registrations) for (const [prefix, backend] of Object.entries(registration.routes)) {
      if (Object.keys(routes).some((route) => route.startsWith(prefix) || prefix.startsWith(route))) throw new Error("Overlapping extension backend routes");
      routes[prefix] = backend;
    }
    return Object.keys(routes).length ? new CompositeBackend(fallback, routes) : fallback;
  }

  middleware() {
    const staticNames = new Set(this.tools.map(({ name }) => name));
    return createMiddleware({
      name: "DcodeExtensions",
      wrapModelCall: (request, handler) => {
        const dynamic = this.native.registrations.flatMap((entry) => entry.tools).filter(({ name }) => !staticNames.has(name));
        if (dynamic.some(({ name }) => this.mcp.tools.some((tool) => tool.name === name))) throw new Error("Dynamic extension tool collides with an MCP tool");
        const tools = [...request.tools, ...dynamic.filter(({ name }) => !request.tools.some((tool) => tool.name === name))];
        for (const tool of tools) if (typeof tool.name === "string") this.observed.set(tool.name, { name: tool.name, description: typeof tool.description === "string" ? tool.description : "" });
        return handler({ ...request, tools, ...(this.context ? { systemMessage: new SystemMessage(`${messageText(request.systemMessage.content)}\nTrusted lifecycle hook context (not tool authorization):\n${this.context}`) } : {}) });
      },
      wrapToolCall: async (original, handler) => {
        let request = original;
        const dynamic = this.native.registrations.flatMap((entry) => entry.tools).find(({ name }) => name === request.toolCall.name && !staticNames.has(name));
        if (dynamic) {
          const action = { name: request.toolCall.name, args: request.toolCall.args };
          const reply = z.object({ decisions: z.array(decisionSchema).length(1) }).parse(interrupt({ actionRequests: [action], reviewConfigs: [{ actionName: action.name, allowedDecisions: ["approve", "reject", "edit"] }] }));
          const decision = reply.decisions[0]!;
          if (decision.type === "reject") return new ToolMessage({ tool_call_id: request.toolCall.id ?? "", content: decision.message ?? "Dynamic tool rejected by the user" });
          if (decision.type === "edit" && decision.editedAction.name !== action.name) throw new Error("Edited dynamic approval cannot change tool identity");
          request = { ...request, tool: dynamic, toolCall: { ...request.toolCall, args: decision.type === "edit" ? decision.editedAction.args : action.args } };
        }
        const signal = request.runtime.signal;
        const payload = { session_id: this.sessionId, tool_name: request.toolCall.name, tool_input: request.toolCall.args, tool_call_id: request.toolCall.id };
        await this.hooks.guard("PreToolUse", payload, signal);
        const agent = request.toolCall.name === "task" ? String(request.toolCall.args.subagent_type ?? "general-purpose") : undefined;
        if (agent) await this.hooks.guard("SubagentStart", { ...payload, agent_name: agent }, signal);
        try {
          const result = await handler(request);
          const outcome = await this.hooks.run("PostToolUse", { ...payload, tool_response: ToolMessage.isInstance(result) ? messageText(result.content).slice(0, 128_000) : "Graph state update" }, signal);
          if (agent) await this.hooks.run("SubagentStop", { ...payload, agent_name: agent, status: "completed" }, signal);
          const context = [...outcome.context, ...outcome.feedback, ...(outcome.blocked ? [outcome.reason ?? "Post-tool feedback requested"] : [])].join("\n");
          return context && ToolMessage.isInstance(result) ? new ToolMessage({ ...result, content: `${messageText(result.content)}\nHook feedback (after execution):\n${context}` }) : result;
        } catch (error) {
          await this.hooks.run("PostToolUseFailure", { ...payload, error: errorText(error) }, signal).catch(() => undefined);
          if (agent) await this.hooks.run("SubagentStop", { ...payload, agent_name: agent, status: "failed" }, signal).catch(() => undefined);
          throw error;
        }
      },
    });
  }

  inventory() {
    return {
      restartRequired: this.native.requiresRebuild,
      observed: this.observed.size > 0, tools: this.observed.size ? [...this.observed.values()] : this.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      mcp: this.mcp.inventory, servers: Object.entries(this.configuration.mcp).map(([name, definition]) => ({ name, transport: definition.transport, enabled: !definition.disabled })),
      agents: this.configuration.agents.map(({ name, description, model, tools, skills }) => ({ name, description, model, tools, skills })),
      plugins: this.native.registrations.map(({ name, version, path, tools, middleware, routes, skills }) => ({ name, version, path, tools: tools.map(({ name }) => name), middleware: middleware.map(({ name }) => name), routes: Object.keys(routes), skills })),
      sources: this.configuration.sources, diagnostics: this.configuration.diagnostics.slice(-30),
    };
  }

  async close(): Promise<void> { await Promise.all([this.hooks.close(), this.mcp.close(), this.native.close()]); }
}
