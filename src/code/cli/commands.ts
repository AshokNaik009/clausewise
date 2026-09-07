export const COMMANDS = [
  { name: "help", aliases: [], description: "Show implemented slash commands" },
  { name: "clear", aliases: [], description: "Start a fresh session with the current model" },
  { name: "threads", aliases: [], description: "List stored sessions" },
  { name: "resume", aliases: [], description: "Resume a session: /resume <session-id>" },
  { name: "continue", aliases: [], description: "Continue an interrupted turn or review pending approvals" },
  { name: "history", aliases: [], description: "Show the current conversation" },
  { name: "tokens", aliases: [], description: "Show token usage in retained root messages" },
  { name: "tools", aliases: [], description: "Show configured integrations and observed runtime tools" },
  { name: "extensions", aliases: ["mcp"], description: "Show trusted MCP, hooks, plugins, agents, and diagnostics" },
  { name: "model", aliases: [], description: "Pick a model or switch: /model [provider:]model" },
  { name: "auth", aliases: [], description: "Show credential source; /auth set opens a masked key field" },
  { name: "config", aliases: [], description: "Show effective settings, provenance, and file health" },
  { name: "reload", aliases: [], description: "Reload a coherent configuration generation at a safe boundary" },
  { name: "manual", aliases: [], description: "Require human approval for gated tools" },
  { name: "auto", aliases: [], description: "Classifier-backed source edits; other actions require review" },
  { name: "yolo", aliases: [], description: "Open explicit unrestricted-mode acknowledgement" },
  { name: "cost", aliases: ["costs"], description: "Show durable request usage and known/unknown costs" },
  { name: "compact", aliases: ["offload"], description: "Archive and summarize idle conversation; preserve usage and goals" },
  { name: "memory", aliases: [], description: "Show session memory, or /memory set <text>" },
  { name: "goal", aliases: [], description: "Show goal; /goal set objective | acceptance criterion" },
  { name: "parity", aliases: [], description: "Show rewrite milestones and remaining gaps" },
  { name: "version", aliases: ["about"], description: "Show the TypeScript port version" },
  { name: "quit", aliases: ["q", "exit"], description: "Exit and preserve the session" },
] as const;
export type CommandName = typeof COMMANDS[number]["name"];

export function parseCommand(input: string): { name: CommandName | null; argument: string } | null {
  if (!input.startsWith("/")) return null;
  const [name = "", ...parts] = input.slice(1).trim().split(/\s+/u);
  const command = COMMANDS.find((entry) => entry.name === name || (entry.aliases as readonly string[]).includes(name));
  return { name: command?.name ?? null, argument: parts.join(" ") };
}
