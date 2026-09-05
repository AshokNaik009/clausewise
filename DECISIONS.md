# Regulatory Comparison Harness — Decision Log

## Purpose

Build a TypeScript CLI harness for evidence-backed thematic comparison of regulatory documents. The initial corpus targets UAE financial-services AML/CFT material. The comparison is advisory analysis, not legal advice or a compliance determination.

## Supported comparison profiles

The harness has four profiles with one common finding schema and typed profile-specific assessments:

1. `consultation-impact` — official UAE consultation against current material.
2. `version-change` — material thematic changes between two versions of an instrument.
3. `cross-guidance` — alignment, scope, and conflicts across guidance documents.
4. `policy-gap` — an external requirement against publicly disclosed corporate policy posture.

## Interaction and durable state

- `reg-compare` with no subcommand starts a conversational DeepAgents shell. Scripted `run`, `resume`, `validate`, `inspect`, `doctor`, fixture, and purge commands remain available.
- The shell discovers local source files by metadata, starts a run, derives a plan, stops for the plan decision, analyzes approved themes, stops for final review, and then answers run/finding follow-ups.
- The run workspace ledger is authoritative. Its immutable events and artifacts, plus its ledger-derived `run-state.json`, are the only cross-process run-resume mechanism.
- The shell's LangGraph `MemorySaver` and `StateBackend` are session-only. They retain neither raw sources nor resumable run authority after the shell exits.
- A workspace lock is acquired only around one staged coordinator operation and is released before an idle reviewer turn. A reviewer can therefore return later without a stale process lock.

## Agent topology and model contract

- TypeScript owns ingestion, state transitions, artifact persistence, retries, validation, citation audit, report rendering, review records, and all workspace writes.
- The shell is an in-process DeepAgents agent with only harness-specific tools. Its filesystem backend is `StateBackend` and all built-in filesystem reads/writes are denied.
- A mapper and per-theme workers are in-process DeepAgents workers using `ChatOpenAI` against an OpenRouter-compatible endpoint. No CLI worker subprocesses or external CLI authentication are part of this architecture.
- Workers use a disposable scratch directory, `FilesystemBackend`, read permission only for `/input/**`, and a deny rule for all other filesystem operations. A worker receives only its bounded context packet, not the durable workspace or complete source corpus.
- Default model: `deepseek/deepseek-chat`. `OPENROUTER_API_KEY` or `REG_COMPARE_API_KEY`, plus `REG_COMPARE_PROVIDER_ORDER`, are required before an external request. The manifest records model, base URL, zero temperature, provider order, `allow_fallbacks: false`, and `data_collection: "deny"`.
- The configured OpenRouter request includes the pinned provider routing object through `ChatOpenAI.modelKwargs`; a unit test inspects invocation parameters without making a request.

## Planning and review decisions

- `create_plan` derives and validates a proposal. `submit_plan` is always gated by a reviewer decision.
- A reviewer may approve, reject, or request one free-text semantic amendment. An amendment triggers a second mapper round and the newly derived plan must itself be approved. The reviewer cannot directly alter themes, record IDs, or plan hashes.
- `analyze_themes` is permitted only after the active plan's durable approval record is present.
- `finalize_run` is always gated. Every published critical or high finding, including in an explicitly confirmed partial result, requires a durable disposition.
- Citation audit is mandatory: worker claims are untrusted until Zod validation and deterministic record/excerpt verification complete.

## Spend and failure controls

- `--agent-call-budget` means external **provider requests**, not worker or subprocess count. A LangChain callback reserves budget immediately before each chat-model request, including tool loops and retries.
- Every successful reservation writes a `model_call_started` immutable ledger event containing a state projection. The ledger validator rejects non-contiguous call numbers, invalid role/theme associations, or disagreement between events, state counters, and the configured budget.
- The conversational shell has a separate in-memory ceiling of 100 model requests per session. It is deliberately not charged to a run's analysis budget and disappears when the shell exits.
- Mapper and worker failures persist a schema-validated attempt artifact with an outcome (`ok`, `model_error`, `schema_invalid`, `timeout`, or `budget_exhausted`) without saving raw exception text. Worker retry and partial-finalization rules remain explicit.

## Data handling and execution

- Inputs are local `.pdf`, `.md`, and `.txt` documents. The shell source tool returns metadata only and rejects previews, so source text is not placed in the coordinating shell context.
- Internal and confidential runs require `--confirm-external-model-access`; confidential runs also require an explicit encrypted-workspace assertion and a bounded retention timestamp. The manifest retains this consent and routing provenance.
- Workspaces use `0700` directories and `0600` files. Immutable artifacts are created atomically, and the event NDJSON mirror is validated against the event files.
- QuickJS remains available only to theme workers through the capability broker. The tool writes a `0600` temporary script, invokes the Unix-socket broker, then removes that script. The worker has no shell capability.

## Test contract

- Unit and integration tests must be deterministic and non-networked. They use fake tool-calling models or mocked harness delegates, never OpenRouter credentials.
- Tests cover source isolation, built-in filesystem denial, plan approve/amend/reject decisions, final-disposition enforcement, lock release, provider-routing parameters, model-call reservations, ledger reconstruction, QuickJS restrictions, and citation-audit rejection.
- `doctor` checks Node, npm, and QuickJS locally. Key and route configuration are informational by default; `doctor --network` is the explicit opt-in reachability check.
- A real model regression is manual and requires configured credentials and provider routing. It must be followed by `reg-compare validate --run <directory>`; it is not part of `npm test`.

## Implementation defaults

- Runs are written beneath `runs/<timestamp>-<profile>/` unless `--output` is supplied.
- `--max-themes` defaults to `6`; `--concurrency` defaults to `2` and is capped at `3`.
- Citations use short excerpts to avoid reproducing large portions of source documents.
- Fixture sources are public, English-language UAE materials pinned by metadata and SHA-256. Ordinary tests do not download them.
