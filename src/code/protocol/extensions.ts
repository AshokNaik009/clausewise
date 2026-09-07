import { z } from "zod";

export const inventorySchema = z.object({
  observed: z.boolean(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  mcp: z.array(z.object({ server: z.string(), name: z.string(), remoteName: z.string(), description: z.string() })),
  agents: z.array(z.object({ name: z.string(), description: z.string() })),
  sources: z.array(z.string()),
  diagnostics: z.array(z.string()),
});
