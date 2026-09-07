import { createMiddleware } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import { webTools } from "../tools/web.js";
import { searchTool } from "../tools/search.js";
import type { CodeSettings } from "../config/configuration.js";
import { loadExtensions, type ExtensionConfiguration } from "./config.js";
import { McpConnections } from "./mcp.js";
import { HookRunner } from "./hooks.js";
import { errorText } from "../shared/output.js";

export class ExtensionHost {
  readonly mcp = new McpConnections();
  readonly hooks: HookRunner;
  readonly tools: StructuredTool[];
  private readonly observed = new Map<string, { name: string; description: string }>();

  private constructor(readonly configuration: ExtensionConfiguration, cwd: string, settings: CodeSettings) {
    this.hooks = new HookRunner(configuration.hooks, cwd);
    this.tools = [];
    this.configureWeb(settings);
  }

  static async create(cwd: string, trusted: boolean, projectContext: boolean, settings: CodeSettings = {}): Promise<ExtensionHost> {
    const configuration = await loadExtensions(cwd, trusted, projectContext);
    const host = new ExtensionHost(configuration, cwd, settings);
    try { await host.mcp.connect(configuration.mcp, cwd); host.tools.push(...host.mcp.tools); return host; }
    catch (error) { await host.close(); throw error; }
  }

  configureWeb(settings: CodeSettings): void {
    this.tools.splice(0, this.tools.length, ...this.mcp.tools, ...(settings.webFetch === true ? webTools() : []));
    if (settings.webSearch === true && process.env.TAVILY_API_KEY) this.tools.push(searchTool());
    if (settings.webSearch === true && !process.env.TAVILY_API_KEY) {
      const message = "Web search was enabled but TAVILY_API_KEY is missing; the tool is not exposed.";
      if (!this.configuration.diagnostics.includes(message)) this.configuration.diagnostics.push(message);
    }
    this.observed.clear();
  }

  middleware() {
    return createMiddleware({
      name: "DcodeExtensions",
      wrapModelCall: (request, handler) => {
        for (const tool of request.tools) {
          if (typeof tool.name === "string") this.observed.set(tool.name, { name: tool.name, description: typeof tool.description === "string" ? tool.description : "" });
        }
        return handler(request);
      },
      wrapToolCall: async (request, handler) => {
        const payload = { tool_name: request.toolCall.name, tool_input: request.toolCall.args, tool_call_id: request.toolCall.id };
        await this.hooks.run("PreToolUse", payload, request.runtime.signal);
        const result = await handler(request);
        try { await this.hooks.run("PostToolUse", payload, request.runtime.signal); }
        catch (error) { this.configuration.diagnostics.push(`Post-tool hook failed after execution: ${errorText(error)}`); }
        return result;
      },
    });
  }

  inventory() {
    return { observed: this.observed.size > 0, tools: this.observed.size ? [...this.observed.values()] : this.tools.map((tool) => ({ name: tool.name, description: tool.description })), mcp: this.mcp.inventory, agents: this.configuration.agents.map(({ name, description }) => ({ name, description })), sources: this.configuration.sources, diagnostics: this.configuration.diagnostics.slice(-30) };
  }

  async close(): Promise<void> { await Promise.all([this.hooks.close(), this.mcp.close()]); }
}
