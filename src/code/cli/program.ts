import { Command, CommanderError, InvalidArgumentError } from "commander";
import { errorText, terminalText } from "../shared/output.js";
import { PARITY_MILESTONES, PORT_VERSION } from "../shared/parity.js";
import type { LaunchOptions } from "./launch.js";

function shellTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new InvalidArgumentError("Shell timeout must be an integer between 1 and 900 seconds");
  return seconds;
}

export function createProgram(): Command {
  const program = new Command();
  program.name("dcode-ts").description("TypeScript rewrite of Deep Agents Code — staged parity, manual approvals, local execution").version(PORT_VERSION)
    .option("-m, --model <name>", "OpenAI-compatible model ID (or DCODE_MODEL)")
    .option("--provider <name>", "named provider from user configuration (or DCODE_PROVIDER)")
    .option("--base-url <url>", "custom endpoint; requires DCODE_API_KEY (or DCODE_BASE_URL)")
    .option("-x, --execute <prompt>", "run headlessly; use - to read the prompt from stdin")
    .option("-r, --resume [id]", "resume by ID/prefix, or the latest session in this directory")
    .option("--attach <server-id>", "reattach to a detached local server without rerunning tools")
    .option("--continue", "continue the unfinished turn in a resumed session")
    .option("--decisions <json>", "resume approvals: {\"interrupt-id\":[{\"type\":\"approve\"}]}")
    .option("--cwd <directory>", "working directory for a new session")
    .option("--config <file>", "explicit user JSON or supported upstream TOML configuration")
    .option("--agent <name>", "configured root-agent profile")
    .option("--recursion-limit <steps>", "maximum graph steps (1–100000)", (value: string) => { const limit = Number(value); if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new InvalidArgumentError("Recursion limit must be 1–100000"); return limit; })
    .option("--state-dir <directory>", "session storage (default: ~/.local/state/dcode-ts/sessions)")
    .option("--json", "emit one machine-readable JSON envelope")
    .option("--stream-json", "emit streaming JSONL envelopes")
    .option("--no-project-context", "do not automatically load project AGENTS.md or skills")
    .option("--trust-extensions", "authorize configured MCP servers, hook commands, and plugin manifests for this run")
    .option("--shell-timeout <seconds>", "maximum shell command duration (default: 120)", shellTimeout)
    .addHelpText("after", "\nCredentials: provider-specific environment or private credential store; DCODE_API_KEY / OPENAI_API_KEY for the default endpoint.\nNo dotenv files are loaded automatically. Local shell execution is not sandboxed.\nExternal web tools are disabled by default. MCP and hooks require --trust-extensions.\nExit codes: 0 completed, 1 error, 2 usage error, 3 awaiting approval, 4 unfinished.\nInteractive and headless modes use a separate agent server. See parity for remaining gaps.");
  program.action(async (options: LaunchOptions) => {
    const { launch } = await import("./launch.js");
    program.setOptionValue("exitCode", await launch(options));
  });
  program.command("auth <provider>").description("show credential source or securely store a key from a named environment variable")
    .option("--from-env <name>", "read this variable without putting its value in command arguments")
    .action(async (provider: string, options: { fromEnv?: string }) => {
      const { Configuration } = await import("../config/configuration.js");
      const { CredentialStore } = await import("../config/credentials.js");
      const { printEnvelope } = await import("../client/headless.js");
      const config = new Configuration(program.opts<LaunchOptions>().cwd ?? process.cwd());
      await config.reload();
      const definition = config.provider(provider, program.opts<LaunchOptions>().baseUrl);
      const store = new CredentialStore();
      if (options.fromEnv) {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(options.fromEnv) || !process.env[options.fromEnv]) throw new Error("The named credential environment variable is invalid or unset");
        await store.set(provider, definition.endpoint, process.env[options.fromEnv]!);
      }
      const credential = await store.resolve(provider, definition);
      printEnvelope("auth", { provider, endpoint: definition.endpoint, source: credential.source });
    });
  program.command("threads").description("list TypeScript sessions").action(async () => {
    const { SessionStore } = await import("../persistence/sessions.js");
    const { printEnvelope } = await import("../client/headless.js");
    const options = program.opts<LaunchOptions>();
    const sessions = await new SessionStore(options.stateDir).list();
    if (options.json) printEnvelope("threads", sessions);
    else process.stdout.write(`${sessions.map((session) => terminalText(`${session.id}  ${session.updatedAt}  ${session.model}  ${session.cwd}`)).join("\n")}\n`);
  });
  program.command("update").description("check the confirmed npm distribution; source checkouts are never self-updated").option("--apply <version>", "explicitly install this eligible version after reviewing an update check").action(async (options: { apply?: string }) => {
    const { Configuration } = await import("../config/configuration.js");
    const { ApplicationUpdates } = await import("./updates.js");
    const { printEnvelope } = await import("../client/headless.js");
    const launch = program.opts<LaunchOptions>();
    const config = new Configuration(launch.cwd ?? process.cwd(), {}, launch.config ? { user: launch.config } : undefined);
    const updates = new ApplicationUpdates((await config.reload()).settings);
    const result = await updates.check();
    if (options.apply) {
      if (!result.plan || result.plan.version !== options.apply) throw new Error("No eligible update matches the explicitly requested version");
      printEnvelope("update", await updates.apply(result.plan, `Update ${result.plan.package} to ${result.plan.version}`));
    } else printEnvelope("update", result);
  });
  program.command("import-python <source> <thread>").description("import completed Python SQLite/JSON conversation history into a new session; never replay Python tasks").action(async (source: string, thread: string) => {
    const { SessionStore } = await import("../persistence/sessions.js");
    const { importPythonSession } = await import("../persistence/python-import.js");
    const { printEnvelope } = await import("../client/headless.js");
    const options = program.opts<LaunchOptions>();
    if (!options.model) throw new Error("Specify --model for the new TypeScript session");
    const session = await importPythonSession(new SessionStore(options.stateDir), source, thread, { cwd: options.cwd ?? process.cwd(), model: options.model, ...(options.provider ? { provider: options.provider } : {}), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
    printEnvelope("import-python", { session, notice: "Imported conversation only. Source preserved; Python tasks, approvals, and billing state were not imported." });
  });
  program.command("recover-lock <id>").description("recover a dead local session lock, preserving it in a recovery archive").action(async (id: string) => {
    const { SessionStore } = await import("../persistence/sessions.js");
    const { printEnvelope } = await import("../client/headless.js");
    printEnvelope("recover-lock", await new SessionStore(program.opts<LaunchOptions>().stateDir).recoverLock(id));
  });
  program.command("show <id>").description("show session metadata without invoking a model").action(async (id: string) => {
    const { SessionStore } = await import("../persistence/sessions.js");
    const { printEnvelope } = await import("../client/headless.js");
    const session = await new SessionStore(program.opts<LaunchOptions>().stateDir).get(id);
    printEnvelope("show", session);
  });
  program.command("parity").description("show implemented features and remaining rewrite milestones").action(async () => {
    if (program.opts<LaunchOptions>().json) {
      const { printEnvelope } = await import("../client/headless.js");
      printEnvelope("parity", PARITY_MILESTONES);
    } else {
      for (const stage of PARITY_MILESTONES) {
        process.stdout.write(`${stage.stage}. ${stage.name} [${stage.status}]\n${stage.features.map((feature) => `   ${feature}`).join("\n")}\n`);
        if ("limitations" in stage) process.stdout.write(`${stage.limitations.map((limitation) => `   Limitation: ${limitation}`).join("\n")}\n`);
      }
    }
  });
  return program;
}

export async function runCli(args = process.argv): Promise<number> {
  const program = createProgram().exitOverride();
  try {
    await program.parseAsync(args);
    return program.opts<{ exitCode?: number }>().exitCode ?? 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    const message = errorText(error);
    if (program.opts<LaunchOptions>().json || program.opts<LaunchOptions>().streamJson) {
      const { printEnvelope } = await import("../client/headless.js");
      printEnvelope("error", { message });
    } else process.stderr.write(`dcode-ts: ${message}\n`);
    return 1;
  }
}

