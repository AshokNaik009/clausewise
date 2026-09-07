# Deep Agents Code TypeScript rewrite: session handoff

Prepared September 7, 2026. This document is intended to be read after clearing the previous chat. Read the quick start first; inspect the rest and the source just in time. Code is authoritative if it differs from this snapshot.

## Continuation update — September 7, 2026

The sections below this update describe the earlier foundation snapshot. Source and `src/code/shared/parity.ts` now take precedence.

- Source is organized under `cli/`, `client/`, `server/`, `runtime/`, `protocol/`, `config/`, `persistence/`, `session/`, `tui/widgets/`, `extensions/`, `tools/`, and `shared/`. Root `cli.ts` and `index.ts` remain stable entry points.
- Interactive Ink and headless clients now share a separate child-process server. IPC is validated, correlated, size-bounded, and event-acknowledged. Session controls are serialized; shutdown waits for active operations before releasing session ownership.
- Configuration/provider selection, private endpoint-bound credentials, model switching, restricted Auto, acknowledged session-scoped YOLO, a completed-request usage ledger, session memory/goals, and archived/recoverable explicit compaction are implemented in stages. See the parity tracker for limitations rather than treating command presence as full parity.
- Trusted integrations include MCP stdio/Streamable HTTP, a subset of direct-exec hooks, declarative plugin manifests with checksums, and custom agents inheriting the parent model and approval gates. MCP OAuth and arbitrary executable extension APIs are not implemented.
- The user expects deployment on a restricted network. External `webSearch` and `webFetch` settings default to false. Search also requires `TAVILY_API_KEY`; no startup web connectivity probes are performed. Internal model endpoints and explicitly trusted MCP services remain usable.
- Product configuration uses `/etc/dcode-ts/config.json`, `~/.config/dcode-ts/config.json`, and `.deepagents/dcode.json`; it is not Devin CLI configuration. Files have `version: 1`, `settings`, and optional named `providers`. Project configuration cannot enable external web tools, define providers, or authorize YOLO. Executable integration definitions use separate `extensions.json` files and require `--trust-extensions`.
- Checks observed during continuation: typecheck/build; development and compiled version commands; child-process startup, model switching with preserved history, lock release, memory/goal restart persistence, missing-YOLO-ack rejection, compaction and usage preservation, local MCP echo and approval gating, and default-off web/private-address guards. No real-provider inference or live external search was used.
- No new test files were added. Existing test imports were updated for relocated modules. The regulatory application is untouched, changes remain uncommitted, and unrelated artifacts are preserved.
- Added dependencies are pinned: Ink 6.8.0, React 19.2.0, React types 19.2.2, MCP SDK 1.30.0, and ipaddr.js 2.2.0. An audit reports the pre-existing Vitest 3.2.4 UI-server advisory; it was not automatically upgraded.

## 1. Quick start for the next agent

### User request and agreed scope

Rewrite the Python coding-agent application at:

`/Users/ashoknaik/claude-experiments/deepagents/libs/code`

in TypeScript inside:

`/Users/ashoknaik/claude-experiments/deep-agents/src/code/`

These are **two different repositories**: `deepagents` is the Python reference; `deep-agents` is the destination. The user explicitly chose **full parity in stages** and **`src/code/`**, not a new `source/` directory.

The foundation has been implemented. It is not full parity and must not be described as a complete replacement for the Python app. Continue implementation rather than creating another scaffold or only documenting a plan.

The next requested workstreams, in order, are:

1. Rich terminal UI and separate agent-server process.
2. Layered configuration, provider/auth management, and model switching.
3. Auto/YOLO modes, cost tracking, advanced memory/compaction, and goals.
4. MCP/OAuth, hooks, plugins, custom agents, and web tools.

Remote sandboxes, ACP, onboarding, updates, and broader diagnostics are still part of the eventual parity backlog, but are not the focus of this next handoff.

### User preferences and boundaries

- The user explicitly said **do not spend time writing more tests; focus on the code**. Honor that unless they change the instruction. Use typechecking, builds, and focused manual/CLI smoke checks. Do not manufacture confidence from placeholder tests.
- A test file was already created before that instruction: `test/unit/code-core.test.ts`. It remains in the worktree; no additional test files were added afterward. Do not silently delete or expand it as part of unrelated work.
- Keep the existing regulatory-comparison application intact. Its `src/cli.ts`, `src/index.ts`, `npm start`, and `reg-compare` command are not this rewrite.
- Do not use subagents unless the user explicitly requests them. This is a development-agent constraint, not a request to remove the product's SDK-backed `task` capability.
- No commit or push was requested. Preserve existing uncommitted work and unrelated files.
- No live model credentials were inspected or used in the completed smoke checks. Do not read `.env`, backups, or unrelated run artifacts to hunt for credentials.

### First actions

1. Work in `/Users/ashoknaik/claude-experiments/deep-agents` and inspect `git status --short`.
2. Read `src/code/protocol.ts`, `runtime.ts`, `launch.ts`, `repl.ts`, and `sessions.ts` before restructuring anything.
3. Read the Python `ARCHITECTURE.md` and scoped `AGENTS.md`; inspect only the reference modules relevant to the current workstream.
4. Run `npm run check` and `npm run build` to establish the current baseline.
5. Implement the client/server boundary first, preserving the existing headless and approval/resume behavior. Then build the rich UI on that boundary.
6. Keep `src/code/parity.ts` honest as work progresses. Its current four stage labels do not map one-to-one to the four workstreams above: workstreams 2 and 3 both fall under its current stage 3.

## 2. Repository and environment snapshot

- Destination branch: `spec-and-scaffold`.
- Last commit observed: `b591eb4` — `Rewrite the README in plainer language and correct stale claims`.
- All rewrite changes are **uncommitted**.
- Observed Node version: `v22.1.0` on macOS.
- Package engine requirement: `>=22.1.0 <23`.
- TypeScript: `5.8.3`; ESM with NodeNext resolution.
- `tsconfig.json`: `rootDir: src`, `outDir: dist`, strict mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Match the existing `.js` suffix convention in TypeScript relative imports.
- Preserve the upstream MIT notice in `src/code/LICENSE`.

Relevant installed package versions:

| Package | Version in package.json |
| --- | --- |
| `deepagents` | `1.13.1` |
| `langchain` | `1.5.10` |
| `@langchain/core` | `1.2.9` |
| `@langchain/langgraph` | `1.4.10` |
| `@langchain/langgraph-checkpoint` | `1.1.5` |
| `@langchain/langgraph-sdk` | `1.9.23` |
| `@langchain/openai` | `1.5.1` |
| `commander` | `13.1.0` |
| `zod` | `4.2.1` |
| `tsx` | `4.19.3` |

No new dependencies were added for the foundation. No rich TUI, MCP adapter, TOML parser, or credential-store package has been selected or added by this work. Check installed packages before using one. New dependencies should be justified, compatible with the actual Node version, and pinned to vetted releases rather than blindly using `latest`. Do not relax repository security controls to make installation work.

Observed worktree before adding this handoff:

```text
 M package-lock.json
 M package.json
?? analysis.json/
?? src/code/
?? test/unit/code-core.test.ts
```

`analysis.json/` existed before this work and is unrelated. Do not touch it. `docs/SPEC.md`, `docs/DECISIONS.md`, and the root README describe the existing application; do not repurpose them as the coding-agent specification. Plain `git diff --stat` omits the untracked rewrite files, so its small diff does not represent the scope of the work.

The only changes to existing package files were the `code` script and `dcode-ts` bin in `package.json`, plus the corresponding root bin entry in `package-lock.json`. A pre-existing root lockfile range for `@langchain/openai` differs from the exact package.json pin; that was not changed by this rewrite. Avoid unrelated dependency churn.

## 3. What exists now

All paths in this table are relative to `src/code/`.

| File | Responsibility |
| --- | --- |
| `cli.ts` | Commander entry point, lightweight help/version/parity, thread listing, metadata display, error envelopes |
| `launch.ts` | Validate launch options, choose/create session, dispatch interactive or headless execution |
| `runtime.ts` | `CodeRuntime`, Deep Agents graph assembly, streaming adaptation, history, manual interrupt resume |
| `protocol.ts` | Current in-process `CodeEvent`, `TurnResult`, message and token types; not yet an IPC protocol |
| `backend.ts` | `CodeBackend`: SDK virtual filesystem plus bounded, cancellable local shell execution |
| `approvals.ts` | Gated tool list, validated interrupt requests and approve/reject decision maps |
| `sessions.ts` | Session metadata, listing, UUID validation, single-writer lock and checkpointer ownership |
| `checkpointer.ts` | `FileCheckpointer`: extends SDK `MemorySaver`, persists storage and pending writes |
| `storage.ts` | Private creation modes, JSON reads, atomic writes, fsync, snapshot size limit |
| `model.ts` | Explicit model selection and OpenAI-compatible endpoint/credential configuration |
| `repl.ts` | Basic readline interface and terminal approval questions; not the desired rich TUI |
| `headless.ts` | Text, single JSON, or streaming JSONL presentation |
| `commands.ts` | Canonical registry for the currently implemented slash commands |
| `output.ts` | Text-content extraction, terminal control filtering, basic error redaction |
| `prompt.ts` | Coding instructions, virtual path semantics, local-execution warnings |
| `parity.ts` | Machine-readable milestones and explicit limitations |
| `index.ts` | Public exports for this isolated implementation |
| `LICENSE` | Upstream MIT notice |

Current architecture:

```text
CLI -> launch -> readline REPL or headless renderer
                   |
                   +-> SessionStore.use -> CodeRuntime -> Deep Agents graph
                                            |                 |
                                            +-> CodeBackend   +-> FileCheckpointer
```

Everything currently runs in one process. The future UI must not call graph internals or manage checkpointer writes itself.

### Runtime behavior to preserve

- `CodeRuntime.create(context, options)` accepts an injected `BaseChatModel`; this allowed network-free smoke checks.
- `turn(prompt, options)` accepts a new prompt, or `null` for continuation/resume.
- Pending approvals prevent a new user prompt from replacing the pending action.
- Decisions are keyed by actual interrupt ID, with exactly one decision per action. Missing, extra, malformed, or disallowed decisions are rejected. Only approve/reject are implemented; editing an action is not.
- `Command({ resume: ... })` is constructed within the runtime after validation.
- The current policy gates `execute`, `write_file`, `edit_file`, `delete`, `task`, `web_search`, and `fetch_url`. The last two names are reserved/gated but no custom web tools are currently registered.
- General-purpose task delegation is supplied by the installed SDK and inherits interrupt policy. Nested delegation/approval behavior was not comprehensively exercised.
- Streaming uses `streamMode: ["messages", "updates"]`, `subgraphs: true`, and a recursion limit of 150. Events include namespace arrays; root assistant text is rendered separately from subagent text.
- `tool_call` events describe requested calls, not proof that execution occurred. Preserve that distinction in the UI.
- `AGENTS.md` and skill paths `.agents/skills`, `.deepagents/skills`, `.devin/skills` are handed to SDK middleware when present. `--no-project-context` disables this automatic loading. This is not full upstream memory/skill management parity.

### SDK integration details already discovered

Inspect installed dependency source when uncertain; do not assume the Python and JavaScript SDK APIs match.

- Read graph state via **`agent.graph.getState(config)`**, not `agent.getState(config)`. The latter is an internal `never`-typed method in the installed LangChain release.
- The installed message generics exposed `usage_metadata` as `never` in this TS setup. `runtime.ts` validates its runtime value with Zod rather than spreading unsafe casts.
- `MemorySaver.storage` and `.writes` are public in checkpoint package `1.1.5`. The current saver serializes their byte arrays as base64 and restores them before graph execution. It is version-coupled and must be reviewed if the SDK is upgraded.
- `CodeBackend` extends `FilesystemBackend` from `deepagents/node`, with `virtualMode: true`. Its nonempty `id` and `execute()` satisfy the SDK execution capability detection.
- The SDK also provides `LocalShellBackend`, but the implementation here owns child processes to support cancellation and shutdown. Do not replace it casually with an adapter that cannot stop commands.
- Useful installed files: `node_modules/langchain/dist/agents/ReactAgent.d.ts`, `node_modules/langchain/dist/agents/middleware/hitl.d.ts`, and `node_modules/@langchain/langgraph-checkpoint/dist/memory.{js,d.ts}`. Deep Agents implementation/declarations are in hashed files under its `dist/`; discover their current filenames rather than assuming the hashes are permanent.

## 4. Running and configuration today

From the destination repository:

```bash
npm run code -- --help
npm run code -- --version
npm run code -- parity
npm run code -- parity --json
npm run check
npm run build
node dist/code/cli.js --version
```

With an explicitly configured model and credentials:

```bash
npm run code -- --model <model-id>
npm run code -- --model <model-id> -x "Explain the repository layout" --json
npm run code -- -r <session-id>
npm run code -- -r <session-id> --continue --json
npm run code -- threads --json
npm run code -- show <session-id>
```

- Model: `--model` or `DCODE_MODEL`. There is deliberately no hardcoded default model ID.
- Endpoint: `--base-url` or `DCODE_BASE_URL`; default is the OpenAI API.
- Credential: `DCODE_API_KEY`; `OPENAI_API_KEY` is a fallback **only for the default endpoint**.
- Custom endpoints require their own explicit `DCODE_API_KEY`. Do not leak another provider's key to a newly selected endpoint.
- Only HTTPS endpoints are accepted, except HTTP on loopback. URL credentials, query strings, and fragments are rejected.
- No dotenv file is automatically loaded. Existing `npm start` does load `.env`, but it launches the unrelated application.
- Resume uses the stored model/endpoint; endpoint environment changes do not silently retarget an existing session. Changing the model on resume is currently rejected. `/model` displays information only.
- `--decisions` takes an interrupt-ID-keyed JSON object; prefer JSON output to obtain IDs instead of guessing them.
- `-x -` reads stdin with a 1 MB prompt limit.
- `--shell-timeout` accepts 1–900 seconds, default 120.
- Exit codes: 0 completed, 1 application error, 2 Commander argument-parsing error, 3 awaiting approval.
- `--json` emits one envelope; `--stream-json` emits JSONL envelopes. Each has `schema_version: 1`, `command`, and `data`. Warnings go to stderr. For machine consumers, use `node dist/code/cli.js` or quiet npm invocation so npm's own script header is not mixed into stdout.

Current slash commands: `/help`, `/clear`, `/threads`, `/resume`, `/continue`, `/history`, `/tokens`, `/tools`, `/model`, `/manual`, `/parity`, `/version`, `/quit`, plus registered aliases. `/tools` currently displays a static SDK catalog with a profile-restriction caveat, not an authoritative live inventory.

## 5. Persistence and security constraints

Default storage: `~/.local/state/dcode-ts/sessions`, overridden with `--state-dir`.

Each UUID session directory contains:

- `session.json`: version, ID, canonical cwd, model, optional base URL, timestamps; no API key.
- `checkpoint.json`: versioned full snapshot of checkpoint storage and pending writes.
- `session.lock`: exclusive writer marker with PID, present during `SessionStore.use`.

The session lock is currently held throughout an interactive session, including idle input. Reads/listing can occur separately; concurrent writers are rejected. Lock cleanup happens in `finally`, but a killed process can leave a stale marker. There is no automatic stale-lock deletion, migration, or Python SQLite-session import. Do not remove existing locks or session files without checking ownership and obtaining any necessary destructive-operation approval.

Snapshot reads and writes are capped at 64 MiB. Atomic replacement preserves the previously saved file when serialization exceeds the cap. The implementation rewrites complete accumulated history on each checkpoint/write, so it is a foundation, not a scalable final persistence design. Preserve pending writes and interruption state when replacing it with an incremental or database-backed implementation.

Local execution is **not sandboxed**. Virtual filesystem paths are relative to the selected repository; shell commands execute on the host with the user's permissions. The shell has a selected environment-variable allowlist, combined stdout/stderr limited to 100,000 bytes, timeout handling, and POSIX process-group termination. Windows child-process behavior is not verified. Do not claim filesystem path normalization contains shell execution.

Project context can affect the model before any tool approval; startup explicitly warns about this. Keep project trust separate from model-requested action approval, especially for future hooks, MCP subprocesses, and executable plugins.

Cancellation or a crash between a tool's side effect and its durable checkpoint can cause replay on continuation. Do not promise exactly-once effects or solve reconnect by silently replaying tool executions.

## 6. Verification status and remaining foundation cleanup

### Observed passing

- `npm run check`.
- `npm run build`.
- Compiled `node dist/code/cli.js --version` returned `0.1.0`.
- `git diff --check`.
- CLI help, version, parity JSON, thread listing, and metadata display.
- A network-free runtime smoke using LangChain's `FakeToolCallingModel`: a proposed write produced one pending approval; a new store/runtime instance restored it; rejection resumed to completion with no remaining approvals. The proposed file write was not approved.
- Interactive startup using a dummy credential, `/help`, and `/quit`; the REPL exited with code 0. No live model request was made.
- Before the user's no-more-tests instruction, the initial nine checks in `test/unit/code-core.test.ts` passed. This is historical, not a current full regression claim.

### Not verified

- Real-provider streaming, tool calling, credentials, or network error recovery.
- Shell timeout/cancellation end-to-end smoke: the attempt was interrupted before it ran.
- Ctrl+C during model streaming, nested tasks, and approval entry; EOF/SIGTERM edge cases were implemented but not fully exercised.
- Cross-process concurrency/crash recovery, because there is no agent server yet.
- Full existing application regression suite; do not claim it ran.

### Targeted cleanup/review before expanding the UI

- Introduce an explicit lifecycle/state model. `CodeRuntime.result()` currently maps absence of approvals to `completed`, even though an unfinished non-approval graph task may still exist. This should not drive a future UI's complete/idle/error status without checking graph state.
- Ensure cancellation drains runtime/checkpointer work before releasing a session lock or allowing a replacement runtime to execute.
- Make replay boundaries and pending-tool state visible when continuing after failure.
- Review full-snapshot growth and define a versioned persistence migration before enabling long-lived sessions and a durable cost ledger.
- Resume hints currently hardcode `dcode-ts`; support the actual invocation (`npm run code --`, direct node script, installed bin) and custom state directory.
- Some API boundaries are type-only; IPC needs runtime validation, maximum message sizes, IDs, and redaction rather than blindly serializing current objects.
- Add a live tool inventory before extending `/tools` to MCP/custom tools.

Temporary smoke state remains at `/private/tmp/dcode-smoke-cf06d889-57ea-455b-8112-92eaa5885d39`. It is disposable and not application data or a configuration prerequisite. The interactive smoke process was gracefully exited while preparing this handoff. Do not assume prior chat shell IDs will be valid after resetting the session.

## 7. Workstream 1: rich terminal UI and separate agent-server process

### Reference files

Under the Python package, read `ARCHITECTURE.md`, then inspect:

- `deepagents_code/client/launch/server.py` and `server_manager.py`
- `deepagents_code/client/remote_client.py` and `non_interactive.py`
- `deepagents_code/server_graph.py`
- `deepagents_code/app.py`, `app.tcss`, `event_bus.py`
- `deepagents_code/tui/textual_adapter.py`, `tui/screens/`, `tui/modals/`, `tui/widgets/`
- `deepagents_code/command_registry.py` and package `COMMANDS.md`

There are 45 public upstream slash commands plus hidden commands; a dozen foundation commands are not parity. Do not load the giant app/adapter files wholesale when a focused symbol search suffices.

### Recommended implementation order

1. Evolve `protocol.ts` into a versioned request/response/event contract with request, session, run, and event IDs. Include initialization, readiness, status, run, approval decisions, cancel, history, session selection, and shutdown.
2. Move model construction, graph execution, checkpointer ownership, and tool execution into a child process. Keep client rendering/input out of that process. Start with a local IPC transport unless source requirements justify a different transport; this is a recommendation, not a previously selected library or protocol.
3. Implement a client adapter consumed by **both** the current headless renderer and future TUI. Do not build a second agent loop for headless mode.
4. Preserve development launch through tsx and built launch through Node. Make help/version avoid server/model imports and spawning.
5. Handle startup failure, heartbeat/disconnect, request correlation, bounded event buffering/backpressure, cancellation, graceful shutdown, and orphan cleanup. Reconnection may replay presentation events, never implicitly rerun tools.
6. Select a maintained TypeScript TUI stack after checking Node compatibility, dependency age, and actual terminal behavior. No framework has been chosen. Ink/React is a candidate, not an installed dependency or mandate. If TSX is selected, update compiler inclusion/JSX settings without disturbing existing source layout.
7. Add streaming transcript, multiline composer, scrollback, status/token/model/approval indicators, tool output, diff review, approval modals, command completion, thread/model pickers, resize handling, and focus/keybinding routing.

### Completion evidence

Both headless and TUI clients use the same separate runtime; approvals survive a client restart; cancel/shutdown do not strand host commands or session writers; terminal output cannot inject escape actions; help/version stay lightweight. Use focused smoke demonstrations, not newly authored test suites.

## 8. Workstream 2: layered configuration, providers/auth, model switching

### Reference files

- `deepagents_code/configuration/{types,provider,providers,resolver,service,writer,paths}.py`
- `deepagents_code/config_manifest.py`, `config.py`, `_paths.py`
- `deepagents_code/model_config.py`, `configurable_model.py`, `model_retry.py`, `reasoning_effort.py`
- `deepagents_code/auth_store.py`, `auth_display.py`, `mcp_login_service.py`
- Related model/auth widgets under `tui/widgets/`

### Required behavior

- Determine precedence and managed-policy enforcement from the reference resolver; do not invent an environment-overrides-everything merge.
- Use one coherent file-configuration generation. A broken file retains that tier's last usable snapshot. Explicit reload and in-app writes advance the generation; the upstream architecture intentionally does not watch files for arbitrary live changes.
- Preserve live environment resolution and the documented bootstrap/diagnostic exceptions. Track provenance so config/model diagnostics can explain the selected value without exposing secrets.
- Choose file-format/path compatibility deliberately. Distinguish product configuration from this development agent's `.devin/` settings. Do not repurpose or overwrite the existing `.devin/config.local.json`.
- Add a provider registry with explicit endpoint, credential, capabilities, reasoning, retry, and streaming support. Verify provider environment names and supported model IDs from source/official documentation when adding defaults.
- Add secure credential persistence and auth flows without storing keys in sessions, prompts, logs, argv, or project config. Do not silently inherit one provider's endpoint/key for another provider.
- Make model switching a server-owned, serialized operation at a safe turn boundary. Preserve conversation/checkpoints and pending approvals; migrate the current immutable-on-resume metadata contract deliberately.
- Replace display-only `/model` with actual selection/settings and implement `/auth` and `/reload` behavior.

### Completion evidence

Explain effective setting provenance; malformed reload does not partially erase working configuration; provider switching does not leak credentials or reset conversation; active or pending turns cannot race a model change.

## 9. Workstream 3: approval modes, costs, memory/compaction, goals

### Reference files

- `deepagents_code/approval_mode.py`, `auto_mode.py`, relevant HITL sections in `agent.py`
- `deepagents_code/cost_tracking.py`, `_session_stats.py`, `bundled_prices.json`, package `PRICING.md`
- `deepagents_code/offload.py`, `offload_api.py`, `offload_middleware.py`, `memory_guard.py`
- `deepagents_code/goal_tools.py`, `goal_state_limits.py`, `goal_state_notice.py`, `goal_rubric.py`, `reliable_rubric.py`
- `deepagents_code/resume_state.py`, `state_migration.py`

### Required behavior

- Manual remains the fallback when mode/config/classification cannot be trusted.
- Auto is classifier-backed policy, **not** an alias for approve-all. Port eligibility restrictions, timeouts, decision boundaries, and notices from the reference.
- YOLO requires explicit acknowledgement and persistent UI visibility. Do not enable it from a project file or treat a previous chat's broad task approval as acknowledgement of arbitrary host execution.
- Apply policy consistently to parent tools, delegated tools, future MCP tools, and any extension bridge. Avoid two competing HITL middleware instances or an unguarded execution path.
- Add durable usage/cost accounting with request/model/provider identity, relevant cache/reasoning dimensions, subagent accounting, and retry/deduplication semantics. The current retained-root-message sum is not a cost ledger and will lose history after compaction.
- Preserve usage history across compaction, model switches, retries, and resumes. Label unknown prices as unknown rather than zero.
- The SDK supplies baseline summarization behavior; the upstream CLI's explicit offload controls, summary model, memory workflows, and artifacts are not ported. Build those on explicit, recoverable state transitions.
- Persistent memory needs explicit trust, size, and write policy; never persist credentials. Do not imply current automatic AGENTS.md loading implements memory management.
- Add bounded goal/rubric state, acceptance criteria, progress/completion transitions, resume semantics, and tool/UI controls without unbounded autonomous retry loops.

### Completion evidence

Mode changes are observable and fail closed; compaction preserves resumability and accounting; cost totals do not double-count replay; goals survive a restart and cannot bypass policy.

## 10. Workstream 4: MCP/OAuth, hooks, plugins, custom agents, web tools

### Reference files

- `deepagents_code/mcp_config.py`, `mcp_tools.py`, `mcp_auth.py`, `mcp_disabled.py`
- `deepagents_code/mcp_login_service.py`, `mcp_oauth_ui.py`, `mcp_providers/`
- `deepagents_code/hooks/`, package `HOOKS.md`
- `deepagents_code/plugins/`, `extensions/`, package `EXTENSIONS.md`
- `deepagents_code/subagents.py`, `skills/`, `managed_tools.py`, `tool_catalog.py`
- `deepagents_code/tools.py`, `unicode_security.py`, `terminal_escape.py`
- Relevant sections of package `THREAT_MODEL.md`

### Required behavior

- Discover and validate MCP definitions; manage stdio/HTTP transports as appropriate, connection lifetime, retries, tool namespacing/collisions, enable/disable, and real tool inventory. MCP tools must participate in approval policy and streaming presentation.
- Implement OAuth with state/PKCE and supported provider metadata/flows, safe callbacks, scoped credential storage, expiry/refresh, cancellation, and cleanup. Do not invent endpoints or put tokens in URLs/logs.
- Decide trust before spawning repository-defined MCP servers or hooks. A tool approval prompt does not authorize arbitrary startup commands.
- Port hook event schemas, lifecycle ownership, timeout/output limits, structured results, and blocking/continuation behavior. Avoid invoking a hook twice when both client and server observe the same lifecycle event.
- Plugins and executable extensions need manifests, compatibility checks, provenance/trust, explicit loading boundaries, and controlled contributions of tools/middleware/skills/backends. Python extensions cannot simply execute in TypeScript; define and document a TypeScript-native API and any deliberate compatibility gaps.
- Custom agents should have validated identity, model/tool/skill configuration, inherited approval boundaries, stream attribution, and cancellation. Do not mutate a process-global harness profile in a way that changes the unrelated regulatory agents.
- Implement actual web capabilities rather than placeholders. Preserve the reference SSRF protections: public HTTP(S), resolution/address checks, redirect revalidation, and connection pinning or equivalent rebinding resistance, with timeouts and response limits. Treat fetched content as untrusted data.
- Keep missing optional integrations from breaking ordinary startup/help.

### Completion evidence

A trusted configured integration can be connected, invoked through approvals, cancelled, and disconnected cleanly. Untrusted executable configuration cannot silently run. Web fetches cannot target private/metadata addresses through redirects or DNS rebinding.

## 11. Reference-reading and development discipline

Before changing a reference-derived behavior, read:

- `/Users/ashoknaik/claude-experiments/deepagents/AGENTS.md`
- `/Users/ashoknaik/claude-experiments/deepagents/libs/code/AGENTS.md`
- Package `ARCHITECTURE.md`, then the relevant source and focused reference tests as behavioral evidence.

The reference is a substantial product, not a small SDK wrapper. Important upstream patterns include lazy heavy imports on startup, one command registry, coherent configuration generations, strict terminal/markup escaping, modal focus ownership, and trust before executable extensions. Translate these properties to TypeScript rather than copying Python-specific Textual code literally.

Follow current session/project instructions. In particular: avoid adding/removing code comments unless asked, prefer existing conventions/libraries, do not add broad dependencies or unsafe dynamic evaluation, and do not modify unrelated security policies. If a matching skill is available, use it; the `textual-screenshot` skill is only relevant when inspecting the Python Textual UI, not automatically for a TypeScript UI.

Update this handoff or the parity tracker with concrete implemented behavior and observed checks after each workstream. Keep unknowns explicit. Do not mark all four workstreams complete because a command exists or a panel renders.

## 12. Copy/paste prompt for the next chat

```text
Continue the Deep Agents Code TypeScript rewrite in
/Users/ashoknaik/claude-experiments/deep-agents/src/code/.

First read:
/Users/ashoknaik/claude-experiments/deep-agents/docs/CODE_REWRITE_HANDOFF.md

The Python reference is:
/Users/ashoknaik/claude-experiments/deepagents/libs/code

Target full parity in stages. The core implementation already exists and is
uncommitted; do not restart from scratch or overwrite unrelated work. Preserve
the existing regulatory-comparison app. Do not write more tests; focus on code,
typechecking, builds, and focused smoke checks. Do not use subagents unless I ask.

Start with the separate agent-server process and rich terminal UI, then continue
with layered configuration/provider-auth/model switching, Auto/YOLO/costs/
memory-compaction/goals, and MCP/OAuth/hooks/plugins/custom agents/web tools.

Inspect the real source and current git state, keep the parity tracker accurate,
and implement the next working increment rather than stopping at another plan.
```
