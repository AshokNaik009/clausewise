import { tool } from "langchain";
import { z } from "zod";
import { registerSecret } from "../config/credentials.js";

export function searchTool() {
  return tool(async ({ query, max_results }, runtime) => {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error("Web search requires TAVILY_API_KEY");
    registerSecret(key);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST", redirect: "error", signal: AbortSignal.any([...(runtime.signal ? [runtime.signal] : []), AbortSignal.timeout(20_000)]),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results, search_depth: "basic", include_answer: false, include_raw_content: false }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Web search returned HTTP ${response.status}`); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_000_000) throw new Error("Web search response exceeds 1 MB");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const result = z.object({ results: z.array(z.object({ title: z.string(), url: z.string().url(), content: z.string(), score: z.number().optional() })).max(20) }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return JSON.stringify({ trust: "Untrusted search results; follow-up page fetches are separately validated and approved.", results: result.results });
  }, { name: "web_search", description: "Search the public web using Tavily. Requires TAVILY_API_KEY and approval; uses one basic search request.", schema: z.object({ query: z.string().min(1).max(2000), max_results: z.number().int().min(1).max(10).default(5) }) });
}
