import { z } from "zod";

export const inventorySchema = z.object({
  observed: z.boolean(),
  restartRequired: z.boolean().default(false),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  mcp: z.array(z.object({ server: z.string(), name: z.string(), remoteName: z.string(), description: z.string() })),
  agents: z.array(z.object({ name: z.string(), description: z.string(), model: z.object({ provider: z.string(), model: z.string() }).optional(), tools: z.array(z.string()).optional(), skills: z.array(z.string()).optional() })),
  servers: z.array(z.object({ name: z.string(), transport: z.string(), enabled: z.boolean() })).default([]),
  plugins: z.array(z.object({ name: z.string(), version: z.string(), path: z.string(), tools: z.array(z.string()), middleware: z.array(z.string()), routes: z.array(z.string()), skills: z.array(z.string()) })).default([]),
  sources: z.array(z.string()),
  diagnostics: z.array(z.string()),
});
