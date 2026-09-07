# Deep Agents Code — TypeScript

`dcode-ts` is a terminal coding agent built with the TypeScript Deep Agents SDK, LangGraph, and an Ink/React interface. It can inspect a project, propose file changes, run approved shell commands, and preserve conversations across sessions.

This directory contains the TypeScript port of the Python application in `deepagents/libs/code`. It is a runnable, staged implementation—not yet a feature-complete replacement for upstream.

> This is separate from the regulatory-comparison application in the same repository. Use `npm run code` for this project. `npm start` launches the regulatory application.

## What works

- Interactive terminal UI and headless text, JSON, and JSONL output through a shared child-process agent server.
- Filesystem and shell tools with manual approvals, restricted Auto mode, cancellation, and durable approval resume.
- Persistent sessions, prompt queues, model switching, session memory, goals, and acceptance rubrics.
- Automatic, bounded rubric review and revision without bypassing tool approvals.
- Conversation compaction, archive browsing, and restoration into a new session.
- Conversation-only imports from supported Python JSON/SQLite checkpoints and explicit stale-lock recovery.
- Layered configuration and named OpenAI-compatible providers with endpoint-bound credentials.
- Trusted MCP integrations, lifecycle hooks, native JavaScript extension modules, and plugin marketplace management.

For the authoritative implementation status, run `npm run code -- parity` or inspect [the parity tracker](shared/parity.ts). [HANDOFF.md](HANDOFF.md) records verification details and the remaining implementation work.

## Requirements

- **Node.js 22.1 or newer within the Node 22 release line**, as required by the repository's package manifest.
- **npm**, using the repository-root `package.json` and `package-lock.json`.
- An **OpenAI-compatible endpoint and tool-calling model**, with its credential available through an explicitly configured environment variable or the application's credential store.
- A terminal for interactive mode. Use headless mode for pipes and automation.
- **`sqlite3`** with `-readonly`, `-safe`, and `-json` support for Python SQLite imports and their verification check.

Python is not required to run the agent or native extensions. Existing Python extension source must be ported; this application does not execute it through a compatibility bridge.

## Quick start

All shell commands below run from the **repository root**, not from `src/code`:

```bash
cd /Users/ashoknaik/claude-experiments/deep-agents
npm ci
npm run code -- --help
```

Before launching a session, make the appropriate credential available in your shell environment. For the default OpenAI endpoint, the application accepts `DCODE_API_KEY` or `OPENAI_API_KEY`. Do not place credentials in prompts, command arguments, or project configuration files.

Replace the quoted placeholders with your actual model ID and project directory:

```bash
npm run code -- --model "<model-id>" --cwd "/absolute/path/to/project"
```

There is no hardcoded default model. You can also select one through `DCODE_MODEL` or user configuration.

**Dotenv files are not loaded automatically.** The root application's `.env` behavior does not apply to this CLI.

### Build and run compiled JavaScript

```bash
npm run build
node dist/code/cli.js --help
node dist/code/cli.js --model "<model-id>" --cwd "/absolute/path/to/project"
```

The build is repository-wide and writes to `dist/`. This source directory is not currently an independently published npm package.

## Configure a provider

Configuration locations:

| Layer | Default path |
| --- | --- |
| Managed | `/etc/dcode-ts/config.json` |
| User | `~/.config/dcode-ts/config.json` |
| Project | `<working-directory>/.deepagents/dcode.json` |

For settings, precedence is **managed → CLI → session/runtime → environment → user → project → defaults**. `/config` shows effective values and provenance. Model/provider identity is also recorded in session metadata; use model selection to change it rather than assuming a configuration reload retargets an existing session.

A user configuration for a named gateway can look like this. Replace the example endpoint and model ID before using it:

```json
{
  "version": 1,
  "settings": {
    "provider": "gateway",
    "model": "<model-id>",
    "webSearch": false,
    "webFetch": false,
    "shellTimeoutSeconds": 120
  },
  "providers": {
    "gateway": {
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "DCODE_GATEWAY_API_KEY",
      "models": ["<model-id>"]
    }
  }
}
```

Make `DCODE_GATEWAY_API_KEY` available through your normal environment/secret-management mechanism, then launch:

```bash
npm run code -- --provider gateway --model "<model-id>"
```

Alternatively, use `--config /absolute/path/config.json` to select an explicit user configuration. Custom endpoints require HTTPS, except HTTP on loopback. Credentials, query strings, and fragments are not allowed in endpoint URLs.

For a one-off endpoint selected with `--base-url`, supply its credential through `DCODE_API_KEY`; the CLI does not silently reuse `OPENAI_API_KEY` for a custom gateway.

Useful interactive configuration commands:

```text
/config
/config set theme "plain"
/config set --user timestamps true
/config unset theme
/model gateway:<model-id>
/auth
/auth set
/reload
```

`/auth set` opens masked input in an initialized session. Stored credentials are bound to both the provider name and endpoint.

Project configuration cannot define providers or authorize unrestricted mode, external web access, update operations, or automatic acceptance of generated criteria. Executable integration definitions have a separate trust gate.

### TOML compatibility

`--config` also accepts the supported upstream TOML subset. Invalid supported scalar values fall back with diagnostics; unsupported settings are rejected rather than silently ignored.

This is **not the full upstream manifest**. TOML is currently read-only: edit it externally and reload. Persistent `/config ... --user` writes and `/auto-update` changes require a JSON user configuration. See [the compatibility mapping](config/compatibility.ts) for the actual supported surface.

## Interactive workflow

Enter ordinary text to ask the agent to work on the selected project. The default mode requires approval for gated actions.

| Area | Useful commands |
| --- | --- |
| Help and status | `/help`, `/version`, `/parity`, `/notifications` |
| Sessions | `/threads`, `/resume <id-or-prefix>`, `/rename <title>`, `/clear` |
| Pending work | `/continue`, `/cancel`, `/queue`, `/queue pause`, `/queue resume` |
| Approvals | `/manual`, `/auto`, `/yolo` |
| Models and agents | `/model`, `/agents`, `/effort`, `/summarization-model` |
| Conversation | `/history`, `/copy`, `/export <new-file>`, `/editor` |
| Context and cost | `/context`, `/context-doctor`, `/tokens`, `/cost` |
| Memory and goals | `/memory`, `/remember <text>`, `/goal`, `/rubric` |
| Archives | `/compact`, `/archives`, `/archives restore <archive-id>` |
| Integrations | `/tools`, `/extensions`, `/mcp`, `/plugins`, `/skills` |
| Lifecycle | `/reload`, `/restart`, `/detach`, `/quit` |

`/auto` is intentionally restricted: eligible source edits are classified, while shell commands, delegation, integrations, and uncertain actions still require review. `/yolo` requires explicit acknowledgement and is session-scoped.

`/clear` starts a new session without deleting the old one. `/restart` does not automatically replay unfinished tools. `/detach` leaves the server available for reattachment for a limited grace period and prints the attach command.

### Goals and rubrics

```text
/goal set Fix the selected bug | The requested behavior works | Verification evidence is recorded
/goal max-iterations 3
/rubric next Explain the verification performed
/goal show
```

Setting criteria does **not** submit an implementation prompt. Send the task afterward.

After an answer, the grader can request another bounded revision. Tool approvals continue to apply. A next-turn rubric survives approval pauses and restores the previous session rubric when the turn finishes. Grading currently uses recorded conversation evidence, not a separate repository-inspecting agent; missing evidence is treated as unknown rather than success.

## Headless usage

```bash
npm --silent run code -- --model "<model-id>" -x "Explain this project's architecture" --json
npm --silent run code -- --model "<model-id>" -x "Review the selected file" --stream-json
printf '%s\n' 'Summarize this project' | npm --silent run code -- --model "<model-id>" -x - --json
```

`--json` emits a single result envelope; `--stream-json` emits JSONL events. Use `npm --silent` or the compiled CLI to avoid npm's script header in machine-readable stdout. Diagnostics go to stderr.

| Exit code | Meaning |
| --- | --- |
| `0` | Completed |
| `1` | Application error |
| `2` | Command-line usage error |
| `3` | Waiting for tool approval |
| `4` | Unfinished work |

When approval is required, resume interactively or pass `--decisions` using the **actual interrupt IDs** returned by the application. A new prompt cannot replace pending approvals.

## Sessions and recovery

Sessions are stored in `~/.local/state/dcode-ts/sessions` by default. Override this with `--state-dir` and use the same directory when resuming.

```bash
npm run code -- threads --json
npm run code -- show <session-id>
npm run code -- --resume <session-id-or-prefix>
npm run code -- --resume <session-id> --continue --json
```

Session directories contain metadata, checkpoints, and optional usage, control, and compaction records. Only one writer may own a session at a time.

### Restore a conversation archive

Use `/compact` to archive and summarize completed history, then `/archives` to select an archive. Restoration requires confirmation and creates a **new session**. It does not overwrite the source or copy approval grants, goal state, or historical billing records.

### Import Python conversation history

```bash
npm run code -- --model "<model-id>" --cwd "/absolute/path/to/project" import-python /absolute/path/sessions.db <python-thread-id>
```

The source can be a supported SQLite database or JSON checkpoint export. Import leaves the source untouched and imports supported completed conversation history only. It does not translate Python graph tasks, pending writes, approval state, arbitrary serialized classes, or incremental/delta checkpoints.

### Recover a dead session lock

```bash
npm run code -- recover-lock <session-id>
```

Recovery refuses live and foreign-host owners and preserves the old lock in a recovery archive. Malformed locks, reused live PIDs, and abandoned recovery guards require operator inspection. Do not manually remove a lock without understanding its owner.

## Hooks, extensions, and plugins

Integrations require explicit trust:

```bash
npm run code -- --model "<model-id>" --trust-extensions
```

Configuration is read from user/project `extensions.json` and hook sources; inspect [the loader](extensions/config.ts) for exact discovery rules. Trusting integrations can start host processes before the agent asks for individual tool approvals.

Native executable extensions are bundled `.mjs` modules exporting `extension(api)`. The API supports tools, middleware, backend routes, agents, skills, and shutdown callbacks. See [the native API](extensions/api.ts). Python extensions are not directly executable in this port.

Plugin workflow:

```text
/plugins marketplace add /absolute/path/marketplace.json
/plugins install example@local
/plugins enable example@local
/plugins update example@local
/plugins disable example@local
/plugins uninstall example@local
```

New installations are disabled. Install/update review is bound to a checksum; enabling requires trust and a successful runtime rebuild. Uninstall retains cached snapshots and data. See [the native marketplace examples](HANDOFF.md#native-marketplace-format) for catalog and manifest formats.

`/install` and `/uninstall` are shortcuts for optional native plugin integrations, not installers for upstream Python extras. Git/GitHub marketplace formats, broader plugin discovery, and plugin auto-update remain incomplete.

## Application updates

```bash
npm run code -- update
```

This checkout reports a development/unbound installation and performs no self-update. No public npm identity has been confirmed.

For a future configured distribution, update code verifies that it is targeting the running global npm installation, selects stable releases at least seven days old, and requires review for a manual update. Auto-update runs before session startup, announces the default on first launch, and can be disabled with `/auto-update off`. Successful updates currently require restarting the application. Real distribution installation/update remains unverified.

## Architecture

```text
CLI
  ├─ Interactive Ink client
  └─ Headless client
          │ validated local protocol
          ▼
     Child-process server
          │ owns session and active run
          ▼
     Deep Agents / LangGraph runtime
          ├─ Approval policy and local backend
          ├─ Session controls and usage ledger
          ├─ Hooks, MCP, and native extensions
          └─ Durable checkpoints and archives
```

| Directory | Responsibility |
| --- | --- |
| `cli/` | Argument parsing, launch, command registry, updates |
| `client/` | Server connection, headless presentation, prompt queue |
| `server/` | Session ownership, run lifecycle, protocol dispatch |
| `protocol/` | Validated requests, events, controls, and transport |
| `runtime/` | Graph construction, model selection, approvals, local tools |
| `config/` | Layered settings, credentials, TOML/environment compatibility |
| `persistence/` | Checkpoints, session metadata, locking, Python import |
| `session/` | Goals, rubrics, memory, usage, tracing, archives |
| `extensions/` | Native API, hooks, MCP, skills, marketplace management |
| `tools/` | Explicitly enabled web capabilities |
| `tui/` | Ink application, command handlers, reusable widgets |
| `shared/` | Output helpers and parity status |

[cli.ts](cli.ts) is the executable entry point; [index.ts](index.ts) is the public module entry point.

## Development and verification

```bash
npm run check
./node_modules/.bin/vitest run src/code
npm test
```

The in-scope checks cover configuration/update behavior, extension approval/scoping, session recovery/import, and an end-to-end child-process flow against a loopback model fixture. They also compile into a temporary directory and launch the compiled CLI without replacing the repository's `dist/`.

**`npm test` does not include the checks colocated under `src/code`.** Run both test commands. The root suite provides regression coverage for the existing repository application.

Keep the coding-agent implementation isolated from the regulatory application. Reuse the installed SDKs and existing project conventions, and update the parity tracker when behavior changes. Avoid describing command availability as full upstream semantic compatibility.

## Safety and current limitations

- Local execution is **not sandboxed**. Shell commands run with the user's host permissions.
- Project instructions and skill metadata can influence the model before action approval. Use `--no-project-context` to disable automatic loading.
- External web tools default to off. Internal model endpoints and trusted MCP connections are configured separately.
- Checkpoints are full snapshots with a 64 MiB cap. A crash or cancellation can replay effects that were not checkpointed; exactly-once execution is not guaranteed.
- Native Anthropic/Google adapters, provider OAuth, interpreter/PTC, remote sandboxes, onboarding, and the full upstream configuration manifest remain pending.
- Complete lifecycle-output delivery, all plugin formats, and several upstream command behaviors remain unfinished.
- Passing local fixtures does not establish real-provider streaming, remote marketplace compatibility, or exhaustive terminal/crash correctness.

See [HANDOFF.md](HANDOFF.md#still-pending-for-the-users-full-parity-request) for the detailed backlog and [LICENSE](LICENSE) for the preserved upstream MIT notice.
