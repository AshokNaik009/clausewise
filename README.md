# Clausewise

Clausewise compares two regulatory documents by **theme and evidence** rather than by line diff,
and produces a result a compliance reviewer can sign their name to.

You talk to it in plain language. It works out what you meant, does the work, stops twice for your
approval, and then answers questions about what it found.

The build contract is [SPEC.md](./docs/SPEC.md); the reasoning behind it is
[DECISIONS.md](./docs/DECISIONS.md).

> The command is still `reg-compare` inside `package.json`, so examples below use it. Run it with
> `npm start`, which loads your `.env`.

---

## The problem

When a regulator publishes new AML/CFT material, a compliance team needs three answers: what
changed, which obligations now need action, and where our policies fall short. Today an analyst
reads both documents end to end and annotates by hand — days of work per publication, repeated for
every circular, consultation and version bump, and only as good as whoever was assigned.

Two obvious shortcuts both fail:

- **A text diff can't answer the question.** Two documents often describe the same obligation with
  different structure, scope and vocabulary. A diff reports hundreds of irrelevant edits and misses
  the one that matters.
- **A chatbot summary can't be audited.** Ask an LLM to "compare these PDFs" and you get fluent
  prose with no traceable link to the source. A claim you cannot locate is a claim you cannot
  defend to a regulator, an auditor, or a board.

## Who it's for

| Audience | What they get |
| --- | --- |
| Compliance analysts and regulatory-change teams | A first-pass thematic comparison with citations already verified, so their job is review rather than discovery |
| MLROs and heads of compliance | An evidence package where every finding resolves to a page or line, with their own decisions recorded alongside |
| Second-line risk and internal audit | A reproducible artifact — the same inputs and decisions rebuild the same run directory months later |
| Advisors and external counsel | A defensible working paper instead of a chat transcript |

The common thread is people whose output has to survive being questioned. This is built for the
moment someone asks "where does it say that?"

## How a run works

1. **Ingest** two local documents (`.pdf`, `.md`, `.txt`) and normalize them into records that keep
   page and line locators.
2. **Map themes** — a mapper subagent proposes a ranked list of themes the pair covers.
3. **You approve the plan.** Nothing is spent on analysis until you do. You can approve, amend or
   reject. An amendment is re-mapped into a second plan that also needs approval; reviewers never
   hand-edit theme structures or record IDs.
4. **Compare each theme** — every approved theme gets its own subagent with its own context.
5. **Audit the evidence** — citations are checked against the stored source. Unverifiable claims
   are dropped, not softened.
6. **You disposition the findings** — every `critical` and `high` action candidate.
7. **Publish** `analysis.json` (canonical) and `report.md` (for readers), then keep answering
   questions about the result.

Everything needed to audit the outcome — sources, context packets, worker results, rejected
findings, your decisions, model provenance and logs — lands in one self-contained run directory.
**The run is the evidence package.**

## What you can measure

Each run writes its own instrumentation into the `coverage` block of `analysis.json` and the files
under `audit/`. These are readable off a finished run, not marketing claims:

| Measure | Field | Target |
| --- | --- | --- |
| Findings whose citations all resolve to stored source | `coverage.verified_finding_ratio` | **1.0**, enforced — an unverifiable citation cannot reach `analysis.json` |
| Approved themes that produced a defensible result | `coverage.theme_outcome_ratio` | 1.0 for a complete run; less forces an explicit partial-finalization decision |
| How much source was actually examined | `coverage.ingestion_page_ratio`, `mapper_body_sample_ratio` | Reported per run, so truncation is visible instead of silent |
| Claims the audit threw out | count in `audit/rejected-findings-1.json` | Recorded every run — a rising rate is a signal about the model |

Two things worth stating as intent rather than measurement:

- **Reviewer attention is concentrated, not replaced.** You disposition a bounded list of serious
  findings instead of reading two full documents. The gate is mandatory; the saving comes from
  narrowing what needs judgement.
- **Turnaround moves from days to a working session.** Machine time is minutes, but the real figure
  depends on your documents and model. Measure it on your own corpus before quoting it.

The tool does not optimise for finding count. One finding that survives the citation audit is worth
more than ten that don't.

## Four profiles

One engine and one result schema, four sets of analysis semantics:

| Profile | Compares | Answers |
| --- | --- | --- |
| `consultation-impact` | current rule vs. a consultation paper | what would this proposal cost us? |
| `version-change` | earlier vs. later version of an instrument | what materially changed? |
| `cross-guidance` | two guidance documents on one topic | do they align, differ, or conflict? |
| `policy-gap` | external requirement vs. our policy posture | where are the gaps? |

You don't have to name the profile. The shell infers it and tells you which it picked, so you can
correct it in the same sentence or at the plan gate.

## The guarantees

These are what separate this from a chat prompt, and they are release gates:

- **Every finding quotes real source text.** The model supplies only a record range; the harness
  pulls the quotation from that span itself. A citation therefore cannot misquote what it cites. A
  range that doesn't resolve, or is too broad to be evidence, is rejected.
- **A human approves the scope, and a human accepts the consequences.** Both gates are enforced in
  the workflow graph, not by a prompt. Non-interactive approval exists only for automated fixtures
  and is marked as such.
- **The conversation is not the record.** Chat is the interface; the run directory is the evidence.
  Nothing you sign off lives only in a transcript, and nothing said in chat rewrites an artifact
  already written.
- **The model chooses what to analyse, never what counts as verified.** Its only tools are harness
  verbs that validate before they write. It can pick sources, profile and themes; it cannot admit
  an unverified citation, skip a gate, or edit a finalized artifact.
- **Code execution is scoped.** A QuickJS sandbox with allowlisted artifact operations — no shell,
  processes, host filesystem or network — capped at 1 second and 32 MB. Every program and result is
  logged.

## Why it's built this way

This is a Deep Agents capstone. The regulatory use case is real, and it was chosen because getting
these four things wrong is immediately visible:

| Capability | How it shows up |
| --- | --- |
| Planning + human-in-the-loop | Graph-level interrupts and durable review records |
| Subagent delegation | One mapper, then N theme workers, each with a bounded context packet |
| Filesystem context offloading | The run workspace is the evidence package; workers see only `/input/packet.json` |
| Code execution | Scoped QuickJS, offered to theme workers for bounded local computation |

Compliance is a good forcing function: a hallucinated finding isn't a cosmetic flaw, it's the whole
failure mode. That's why the evidence contract is mechanical rather than an instruction in a prompt.

## Architecture

Four layers:

- **Shell agent** — [deepagents](https://www.npmjs.com/package/deepagents) on LangGraph. Turns
  natural language into harness verbs, owns the conversation, explains results. Its tools are the
  only way it can affect anything.
- **Coordinator** — TypeScript. Everything that must be reproducible: the state machine,
  normalization, schema validation, citation verification, budgets, materiality gating, report
  rendering. The only writer of durable artifacts.
- **Semantic delegates** — the mapper and the per-theme workers. Isolated context, no shell or
  network, results returned as JSON that is schema-validated before the coordinator accepts it.
- **Model** — any OpenAI-compatible endpoint. Drives both the shell and the delegates. Configured
  by environment, pinned for reproducibility, recorded per run.

```text
                    +---------------------------------------------+
                    |  reg-compare      (no subcommand -> chat)    |
                    |  run  resume  validate  inspect  doctor      |
                    +----------------------+----------------------+
                                           |
                     natural language      |      scripted flags
                                           v
+----------------------------------------------------------------------+
|  SHELL AGENT                        deepagents / LangGraph           |
|                                                                      |
|  resolves intent, picks profile + sources, explains results          |
|  tools: inspect_sources  start_run   create_plan   submit_plan       |
|         analyze_themes   finalize_run  inspect_run  validate_run     |
|         read_findings                                                |
|  interrupts on: submit_plan, finalize_run                            |
+----------------------------------+-----------------------------------+
                                   |  every tool call
                                   v
+----------------------------------------------------------------------+
|  COORDINATOR                       TypeScript - deterministic        |
|                                                                      |
|  workflow state machine  |  schema validation      |  retry policy   |
|  citation verification   |  materiality gating     |  report render  |
|  call budgets            |  model provenance       |  event ledger   |
|                                                                      |
|  * sole writer of durable artifacts *  * gates cannot be bypassed *  |
+-----+----------------------+----------------------+------------------+
      |                      |                      |
  delegates              verifies               persists
      v                      v                      v
+------------------+   +-----------------+   +--------------------+
| SEMANTIC         |   |     QuickJS     |   |   RUN WORKSPACE    |
| SUBAGENTS        |   |  scoped REPL    |   |  evidence package  |
|                  |   |                 |   |                    |
| mapper      x1   |   | list / read /   |   | sources/ planning/ |
| theme worker xN  |   | writeArtifact() |   | reviews/ workers/  |
| (<=3 at once)    |   |                 |   | audit/   quickjs/  |
|                  |   | no shell, net,  |   | logs/    events/   |
| own context      |   | process, or fs  |   | analysis.json      |
| no shell/network |   | 1s / 32MB caps  |   | report.md          |
| JSON out only    |   +-----------------+   +--------------------+
+-----+------------+
      |
      |  every semantic call
      v
+--------------------------------+
|   OpenAI-compatible endpoint   |
|        << LLM BRAIN >>         |
|                                |
|  drives the shell loop and     |
|  the per-theme comparisons     |
|  temperature 0, pinned route   |
|  model + provider recorded     |
+---------------+----------------+
                |
                |  untrusted until schema + citations validated
                +--------->  back to COORDINATOR
```

### How workers are isolated

Earlier builds ran each theme worker as a separate sandboxed OS process with no network. Subagents
give that boundary up, so here is what replaces it:

- Each delegate has its own context. Source text never enters the shell agent's conversation.
- Delegates get no shell, network or host-filesystem tools. Beyond reading their context packet,
  their only capability is the scoped QuickJS bridge.
- The packet lives in a per-delegate temporary directory. The backend runs in `virtualMode`, which
  makes that directory a real virtual root: the delegate addresses `/input/packet.json`, traversal
  (`..`, `~`) and absolute escapes are refused by the backend, and the permission rules match the
  same namespace the delegate is told about. Without it, `rootDir` is only a working directory for
  relative paths and an absolute path escapes to the host root.
- The QuickJS socket lives in its own short-named directory rather than under the delegate's
  scratch path, because a socket path is capped at 104 bytes on macOS (108 on Linux) and a
  scratch-relative path exceeded it. Scripts reach the sandbox in memory and are never written to
  disk.
- A delegate's result re-enters the coordinator only as JSON that is schema-validated and
  citation-audited. It is never spliced into the shell's message history as free text.

That last point is the one that matters. Source documents are treated as hostile input: prompt
injection inside a PDF must never reach the agent holding `finalize_run`. The shell's discovery tool
returns only path, type and size; ingestion and packet building stay in TypeScript.

The shell keeps conversation state in memory only. It is not a resume database — the immutable
ledger and its validated state projection are authoritative. The coordinator holds a workspace lock
only while executing one step, never while you're deciding at a gate.

Supporting libraries: `pdfjs-dist` for PDF extraction with page boundaries, `quickjs-emscripten` for
the sandbox, `@langchain/openai` for the model adapter, `commander` for the CLI.

Fixtures are real, public UAE sources — mostly CBUAE AML/CFT material — pinned by URL, publication
metadata and SHA-256, so tests never hit the network.

Tests run at three offline levels: unit tests for isolation, ledger, routing, review, citation and
QuickJS behaviour; integration tests for CLI and workflow boundaries; and local fixture checks. A
real-model regression is a separate manual step that checks invariants rather than snapshotting
model prose.

## Using it

Conversational is the default. `npm start` runs the CLI through `tsx --env-file=.env`, so your
credentials load automatically.

![The Clausewise conversational shell: npm start renders the CLAUSEWISE banner, then a reg-compare prompt comparing the 2021 and 2022 CBUAE STR guidance PDFs](./docs/images/shell-session.png)

Naming files is optional. `inspect_sources` resolves a request like `compare the 2021 and 2022
CBUAE STR guidance` against the fixture cache, and the shell tells you which pair and profile it
chose. Follow-up questions run against the finished run:

```console
reg-compare> why is thm-002 only medium materiality?
reg-compare> show me the evidence for f-003
```

Scripted, for CI and fixtures:

```bash
npm start -- doctor                     # local preflight: node, npm, QuickJS

npm start -- run \
  --profile consultation-impact \
  --baseline ./documents/current-aml-guidance.pdf \
  --candidate ./documents/proposed-rule.pdf \
  --data-classification public \
  --output ./runs/aml-consultation \
  --auto-approve

npm start -- resume   --run ./runs/aml-consultation   # continue from the gate it stopped on
npm start -- validate --run ./runs/aml-consultation   # re-check a run, no model calls
npm start -- inspect  --run ./runs/aml-consultation   # summarize a run
```

Both paths share the same schema, ledger and validation rules. Timestamps and generated run IDs
deliberately prevent byte-identical runs. A run started in conversation can be inspected, validated
or continued with the scripted commands.

## Configuration

Copy `.env.example` to `.env` and fill it in. `npm start` loads it; `.env` is gitignored.

```bash
OPENROUTER_API_KEY=sk-or-v1-...              # or REG_COMPARE_API_KEY
REG_COMPARE_PROVIDER_ORDER=GMICloud          # required; the route recorded as run provenance
REG_COMPARE_MODEL=minimax/minimax-m3:free    # optional; code default is deepseek/deepseek-chat
REG_COMPARE_BASE_URL=https://openrouter.ai/api/v1  # optional; any OpenAI-compatible endpoint
```

Any OpenAI-compatible endpoint works. For Groq, for example:

```bash
REG_COMPARE_API_KEY=gsk_...
REG_COMPARE_BASE_URL=https://api.groq.com/openai/v1
REG_COMPARE_MODEL=openai/gpt-oss-20b
REG_COMPARE_PROVIDER_ORDER=groq
```

`REG_COMPARE_PROVIDER_ORDER` is always required, because it is recorded as run provenance. It is
only sent as routing when the base URL is OpenRouter.

Running the CLI any other way (`npx tsx src/cli.ts`, or the built `dist/cli.js`) does **not** read
`.env` — nothing in `src/` loads dotenv. Pass `--env-file=.env` yourself, or export the variables.

### Picking a provider route

On OpenRouter, runs pin `allow_fallbacks: false` for reproducibility, so the provider you name must
actually serve your model — otherwise there are zero endpoints and every request 404s with
`No endpoints found`. The provider slug is not the vendor name: `deepseek/deepseek-chat` is served
by `DeepInfra` and `StreamLake`, not by anything called `DeepSeek`. List the real routes first:

```bash
curl -s "https://openrouter.ai/api/v1/models/<author>/<slug>/endpoints" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data.endpoints[].provider_name'
```

### Free-tier accounts

The shell and every worker need tool calling, so check that first. Catalog availability changes, so
re-query rather than trusting a hardcoded list. Errors worth recognising:

- **402, "requires more credits, or fewer max_tokens"** — the key can't afford the request. The
  harness doesn't set `max_tokens`; the client and provider choose the default completion cap.
- **404, "This model is unavailable for free"** — that free variant is retired. Re-query the
  catalog instead of assuming the paid replacement is reachable.
- **429 rate limits** — either the model is rate-limited upstream, or you've hit a per-minute token
  cap. Groq's free tier, for instance, allows 8,000 tokens per minute, which a large context packet
  will exceed on its own.

`doctor --network` can report PASS in all of these: it probes the catalog endpoint, not a real
completion, so it confirms neither affordability nor the specific model's route.

`doctor` on its own checks Node, npm and QuickJS locally. Key and routing problems are reported but
don't fail it, which keeps the test suite offline.

Every run records model ID, base URL, temperature `0`, provider order, `allow_fallbacks: false` and
`data_collection: "deny"` in `manifest.json`.

### Budgets

Two separate limits:

| Limit | Scope |
| --- | --- |
| `--agent-call-budget` (2–48, default 24) | Analysis provider requests, including tool loops and retries |
| `LIMITS.maxShellModelCalls` (100) | Shell-session requests, in memory, reset when the shell exits |

Before every mapper or worker request, a callback reserves one analysis call and writes a
`model_call_started` ledger event. `validate` reconciles those events against `run-state.json`, so
retries can't quietly overspend.

The mapper and each theme worker also have their own ceiling of six requests. Remember that a
delegate is a loop, not one inference: reading the packet costs a request, answering costs another,
and each structured-output repair costs one more. When a delegate runs out, its outcome is
`model_error` — which reads like the model's fault even when it isn't, so check the attempt artifact
before blaming it.

### When a delegate fails

A failed attempt records the real reason, not just its outcome class:

| File | Contents |
| --- | --- |
| `planning/mapper-attempt-<n>.json` | Outcome plus the underlying error in `stderr`, redacted and size-bounded |
| `planning/mapper-rejected-<n>.json` | The model output that was rejected, so a schema failure is inspectable |
| `workers/<theme>/attempt-<n>.json` | The same, per theme worker |
| `logs/orchestrator.ndjson` | Stage-level operational log |

Earlier builds deliberately stored no exception text, which made real failures impossible to
diagnose. That decision was reversed. Credentials are redacted before anything is written.

### Data classification

`--data-classification internal` or `confidential` requires `--confirm-external-model-access`,
acknowledging that document text is sent to the configured endpoint, whose retention terms are
outside this tool's control. `confidential` additionally requires `--confirm-encrypted-workspace`
and `--retention-until`. The consent and routing provenance stay in the immutable manifest. Review
your provider's data policy before classifying anything above `public`.

## Current state

| | |
| --- | --- |
| Specification | [SPEC.md](./docs/SPEC.md) |
| Decision log | [DECISIONS.md](./docs/DECISIONS.md) |
| Implementation | Conversational path runs through ingestion, theme mapping and the plan gate. The analysis and publication stages have not yet been re-verified end to end on a live model since the citation change — recent attempts stopped on provider rate limits, not harness errors. |

Spikes that gate "core complete" (SPEC §16): dependable structured output and multi-turn tool
calling from the configured model, QuickJS embedding that leaks no Node capabilities, PDF page and
quote stability good enough for exact citation checks, and public-source redistribution rights. If a
spike fails, the rule is to stop and revise the spec — not to quietly weaken a guarantee.
