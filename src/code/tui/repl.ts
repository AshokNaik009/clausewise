import { AgentClient } from "../client/agent-client.js";
import type { RuntimeOptions } from "../runtime/agent.js";
import type { SessionInfo, SessionStore } from "../persistence/sessions.js";
import { runTerminal } from "./app.js";

export async function runInteractive(store: SessionStore, initial: SessionInfo, options: RuntimeOptions = {}): Promise<void> {
  if (options.model) throw new Error("Injected models are supported by CodeRuntime, not the separate-process terminal client");
  const client = await AgentClient.start(store.directory, initial.id, {
    projectContext: options.projectContext !== false,
    shellTimeoutSeconds: options.shellTimeoutSeconds ?? 120,
  });
  try { await runTerminal(client, store.directory); } finally { await client.close(); }
}
