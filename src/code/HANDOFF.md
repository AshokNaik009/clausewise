# TypeScript coding-agent checkpoint

Updated September 7, 2026. This is a runnable implementation checkpoint, **not full upstream parity**. The remaining items below are real implementation gaps, not merely missing tests.

## Scope and decisions

- Implementation, new verification files, and this handoff are confined to `src/code`.
- Preserve the existing uncommitted work. No commit, publication, package installation, live credential use, or changes to the regulatory application's implementation were made in this continuation.
- The reference is `/Users/ashoknaik/claude-experiments/deepagents/libs/code`.
- Native TypeScript extension equivalents were selected. Existing `.py` extensions must be ported; no Python extension execution bridge is promised.
- A public npm package identity has not been confirmed. The updater refuses this private source checkout and cannot update the unrelated `reg-compare` package.
- The existing `docs/CODE_REWRITE_HANDOFF.md` was intentionally not edited because it is outside the requested boundary. This file and `shared/parity.ts` supersede its older status claims.

## Implemented in this continuation

### Goals and rubrics

- Accepted criteria are injected into agent context.
- A completed agent response is assessed automatically. Unmet or unknown criteria produce bounded revision requests, with all normal tool approvals still enforced.
- `maxIterations` limits grading attempts; unknown evidence never counts as success.
- A next-turn rubric temporarily overrides, then restores, the previous session rubric. Its active-turn state survives approval pauses and reloads.
- A grading error/cancellation leaves the turn active for explicit `/continue`; it is not silently declared complete.
- Grading uses recorded conversation evidence. A repository-inspecting grading agent is still missing.

### Sessions

- `recover-lock` verifies that the recorded local PID is no longer alive and archives the lock instead of deleting its evidence. Live and foreign-host locks are refused.
- `import-python` reads JSON checkpoint exports or the latest root checkpoint from Python SQLite sessions. Supported MessagePack message envelopes are decoded as data, without Python imports, pickle, or constructor execution.
- Import is conversation-only and requires supported, completed text-message history. Python tasks, pending writes, approvals, billing state, and delta snapshot reconstruction are not migrated.
- `/archives` offers a picker and confirmation. Restore creates a new session with completed conversation history; the source session and archive remain intact. Approval grants, goal state, credentials, and historical billing are not copied.
- SQLite import requires a system `sqlite3` executable supporting `-readonly`, `-safe`, and `-json`.

### Native extensions and plugins

- Dynamic extension tools are filtered after registration by the selected agent's scope, and execution also checks scope. Approval alone cannot override an agent's tool restriction.
- Failed extension setup rolls back registrations and runs cleanup.
- Safe hook terminal sequences reach the interactive client during runs. Clipboard and arbitrary control sequences are rejected; headless output never executes them.
- Plugin marketplace registration, reviewed installation/update, enable/disable, and uninstall are wired to `/plugins`.
- New installations are disabled. Enabling requires `--trust-extensions` and rebuilds the runtime.
- Native snapshots are content-addressed and entry checksums are verified. Updates are bound to the reviewed digest. Uninstall removes the registry entry but retains snapshots/data.
- A changed plugin registry blocks further runs until a successful reload or restart, including when a reload fails.
- Preview output lists contribution metadata rather than dumping hook environments or command arguments.

### Installation and updates

- `/install` and `/uninstall` manage optional native plugin integrations, not Python package extras.
- `/update` and the `update` CLI check a configured public npm identity against the running global installation before proposing any operation.
- Only stable releases at least seven days old are eligible. Operations use fixed npm arguments, disabled lifecycle scripts, an installation-level lock, and version readback.
- `/auto-update` persists the preference in user JSON configuration. Verified npm installations announce the default once and skip the first installation; source/unbound installations never self-update.
- Automatic updates happen before session startup and exit afterward. Automatic re-execution is not implemented.
- Package-manager behavior is verified using an injected fixture runner, not a real registry or global install. Live packaging validation awaits a confirmed distribution.

### Configuration

- TOML/environment mapping is now table-driven for the supported settings in `config/compatibility.ts`.
- Malformed supported scalar values fall back with diagnostics without discarding valid siblings. Unsupported settings still fail explicitly.
- Added behaviors include update preferences, native-extension enablement, memory-saving instructions, explicit Auto-mode criteria acceptance, thread sort/time display, cwd hiding in the TUI footer, end-of-session usage display, and durable session-cost warnings.
- Configured recursion limits use the upstream 25–100000 range; explicit CLI values accept 1–100000.
- TOML is still read-only. For `/config set --user` and `/auto-update` persistence, use the existing JSON user configuration or edit TOML externally and reload.

## Run and verify

From `/Users/ashoknaik/claude-experiments/deep-agents`:

```bash
npm run code -- --help
npm run code -- parity --json
npm run code -- update
npm run check
./node_modules/.bin/vitest run src/code
npm test
```

The in-scope build verification compiles into a temporary directory, launches the compiled CLI, and cleans up its own artifacts. It does not replace `dist/`.

For interactive use, supply an existing model/provider configuration and its endpoint-bound credential environment variable, then launch the normal `npm run code -- ...` command. Dotenv files are not automatically loaded. Only add `--trust-extensions` for extension sources you have reviewed.

Example session interactions:

```text
/goal set Fix the selected bug | The requested behavior works
/rubric next Include concrete verification evidence
/goal max-iterations 3
/goal show
/compact
/archives
```

Setting a goal or rubric does not itself submit an implementation prompt. Send the task afterward.

Import and recovery commands:

```bash
npm run code -- --model <model-id> --cwd <project> import-python <sessions.db-or-checkpoint.json> <python-thread-id>
npm run code -- --state-dir <sessions-directory> recover-lock <typescript-session-id>
```

Imports never write to the Python source database. Do not attempt recovery while the original writer is alive. A malformed lock or abandoned `.recovery` guard needs operator inspection; no automatic deletion is performed.

## Native marketplace format

A local catalog points to native manifests relative to the catalog file:

```json
{
  "name": "local",
  "plugins": [{ "name": "example", "source": "plugin.json" }]
}
```

A minimal declarative native manifest:

```json
{ "apiVersion": 1, "name": "example", "version": "1.0.0" }
```

Executable manifests additionally provide `entry: { "path": "entry.mjs", "sha256": "<actual-sha256>" }`. The bundled module exports `extension(api)`. Read `extensions/api.ts` for the actual registration interface. Do not use a placeholder hash for installation.

```text
/plugins marketplace add /absolute/path/marketplace.json
/plugins install example@local
/plugins enable example@local
/plugins update example@local
/plugins disable example@local
/plugins uninstall example@local
```

HTTPS catalogs are implemented with public-address/DNS/redirect guards, but remote installation is unverified. Git/GitHub sources and all upstream marketplace/component formats are not implemented.

## Verification observed

- Typecheck passed.
- In-scope checks: 20 passed across four files, including temporary compilation and compiled CLI startup.
- A loopback OpenAI-compatible fixture exercised the actual child-process protocol, model invocation, goal grading, compaction, archive command routing/confirmation, session switching, and lock release.
- SQLite MessagePack and JSON imports preserve their source bytes; unsafe constructors and pending tool calls are rejected.
- Existing regression suite: 55 unit checks and 2 integration checks passed; sanity doctor passed.
- `git diff --check` passed.
- No real model endpoint, remote marketplace installation, global npm update, or live credentials were used.
- Real terminal keypress/modal behavior, provider streaming, and exhaustive crash/race scenarios remain unverified.

## Still pending for the user's full-parity request

1. The **full upstream configuration manifest and setting-specific behavior**, including interpreter/PTC, remote sandboxes, native provider/auth workflows, onboarding, broader display/themes, shell policy, warnings, and structured configuration tables.
2. Complete upstream command semantics beyond command-name coverage, including Python-extra equivalents and the remaining MCP/auth/notification workflows.
3. Native extension discovery/provenance across every upstream source scope, all marketplace formats and plugin components, and opted-in plugin auto-update.
4. Complete startup/shutdown/compaction terminal-output delivery and the remaining lifecycle/output contract details.
5. Repository-inspecting rubric grading, exhaustive next-turn crash reconciliation, incremental Python checkpoint reconstruction, and broader archive content compatibility.
6. Confirm a real npm distribution identity and verify packaging/install/update on that distribution. Do not publish or guess a package name without confirmation.
7. Full interactive terminal, live-provider, remote-integration, and crash/security lifecycle verification.
