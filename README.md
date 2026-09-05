# Regulatory Document Comparison Harness

`reg-compare` is a local command-line tool that compares two regulatory documents **by theme and evidence**, not by line diff, and produces an auditable result a compliance reviewer can sign off on.

Status: **implementation in progress.** The build contract is [SPEC.md](./SPEC.md); the reasoning behind it is [DECISIONS.md](./DECISIONS.md).

---

## The problem

When a regulator publishes new AML/CFT material, a compliance team has to answer three questions: what changed, which obligations now require action, and where do our policies fall short of the requirement.

A textual diff cannot answer these. Two documents routinely describe the same obligation with different structure, scope, legal status, and vocabulary — so a diff reports hundreds of irrelevant edits and misses the one substantive change. Conversely, asking a general-purpose LLM to "compare these PDFs" produces fluent summaries that nobody can audit, defend to a regulator, or trust.

## What we are building

A CLI that runs a bounded, reviewable workflow:

1. **Ingest** two local documents (`.pdf`, `.md`, `.txt`) and normalize them into records that keep page or line locators.
2. **Map themes** — one agent proposes a ranked catalogue of regulatory themes covered by the pair.
3. **Human gate #1** — a reviewer approves, rejects, or amends that plan in the terminal before any analysis runs.
4. **Compare per theme** — each approved theme gets its own isolated agent worker that examines how both documents treat it.
5. **Audit the evidence** — every finding's citations are mechanically verified against the stored source text. Unverifiable claims are rejected, not softened.
6. **Human gate #2** — the reviewer dispositions every `critical` and `high` action candidate.
7. **Publish** `analysis.json` (canonical) and `report.md` (reviewer-facing).

Everything the run touched — sources, prompts, raw model output, worker results, rejected findings, review decisions, logs — is written to a self-contained run directory. The run *is* the evidence package.

### Four comparison profiles

One engine, one result schema, four analysis semantics:

| Profile | Compares | Answers |
| --- | --- | --- |
| `consultation-impact` | current rule vs. a regulator consultation paper | what would this proposal cost us? |
| `version-change` | earlier vs. later version of an instrument | what materially changed? |
| `cross-guidance` | two guidance documents on one topic | do they align, differ in scope, or conflict? |
| `policy-gap` | external requirement vs. our public policy posture | where are the gaps? |

### The non-negotiables

These are what separate this from a chat prompt, and they are release gates:

- **Every material finding cites exact, verifiable source text.** The excerpt must resolve to its stated page/line locator in the stored normalized source. Citations that fail verification cannot reach `analysis.json` or `report.md`.
- **A human approves the scope, and a human dispositions the consequences.** Two mandatory terminal gates. Non-interactive approval exists only for automated fixtures and is marked as such in the record.
- **Agents propose; the coordinator decides.** TypeScript owns all durable state, validation, retries, and rendering. Model output is untrusted until it passes schema and citation validation — a subagent's answer is a candidate, not a result.
- **Code execution is scoped.** A QuickJS REPL with allowlisted artifact read/write/list operations — no shell, no processes, no host filesystem, no network. Every program and result is logged.

### What this is not

Not legal advice, not a compliance determination, and not a replacement for qualified review. It does not fetch documents from the internet during a run, does not translate non-English sources, and does not integrate with GRC or case-management systems. A `policy-gap` result describes *publicly disclosed* policy posture — never an organization's complete internal control environment.

---

## Why it's shaped this way

This is a Deep Agents capstone. The regulatory use case is real, but the architecture is deliberately built to exercise four capabilities under conditions where getting them wrong is visible:

| Capability | How it shows up here |
| --- | --- |
| Planning + human-in-the-loop | Theme plan review before spend; finding disposition before publication |
| Subagent delegation | A deepagents mapper subagent, then N per-theme comparison subagents, each with its own context |
| Filesystem context offloading | The deepagents filesystem backend is rooted at the run workspace — the shared knowledge base across subagents |
| Code execution | Scoped QuickJS for citation verification and coverage checks |

Compliance work is a good forcing function: hallucinated findings are not a cosmetic flaw, they are the whole failure mode. That is why the evidence contract is mechanical rather than a prompt instruction.

## Stack and architecture

Three distinct layers — the first two are easy to conflate:

- **Harness — [deepagents](https://www.npmjs.com/package/deepagents) on LangGraph.** Owns orchestration: the planner, subagent delegation, the filesystem backend rooted at the run workspace, and state transitions.
- **Reasoning engine — `devin -p`.** The LLM brain. Invoked non-interactively for the semantic work: proposing themes, and comparing how two documents treat one theme. It is *not* the harness and does not run agent sessions, own a workspace, or write artifacts.
- **Deterministic layer — TypeScript.** Everything that must be reproducible: normalization, schema validation (zod), citation verification, retry policy, materiality gating, report rendering.

```text
                    +---------------------------------------+
                    |         reg-compare  (CLI)            |
                    |  doctor    run    validate   inspect  |
                    +------------------+--------------------+
                                       |
                                       v
+----------------------------------------------------------------------+
|  COORDINATOR                       TypeScript - deterministic        |
|                                                                      |
|  workflow state machine  |  zod schema validation  |  retry policy   |
|  citation verification   |  materiality gating     |  report render  |
|                                                                      |
|  * sole writer of durable artifacts *   * owns HITL gates 1 and 2 *  |
+-----+----------------------+----------------------+------------------+
      |                      |                      |
  delegates              verifies               persists
      v                      v                      v
+-----------------+      +-----------------+      +--------------------+
| DEEPAGENTS      |      |     QuickJS     |      |   RUN WORKSPACE    |
| (LangGraph)     |      |  scoped REPL    |      |  evidence package  |
|   THE HARNESS   |      |                 |      |                    |
|                 |      | list / read /   |      | sources/ planning/ |
| mapper          |      | writeArtifact() |      | reviews/ workers/  |
| subagent        |      |                 |      | audit/   quickjs/  |
|                 |      | no shell, net,  |      | logs/              |
| theme           |      | process, or fs  |      | analysis.json      |
| subagents xN    |      | 1s / 32MB caps  |      | report.md          |
| (<=3 at once)   |      +-----------------+      +--------------------+
+-----+-----------+
      |                                                      ^
      |  reads theme context / writes scratch ----- via -----+
      |  the deepagents filesystem backend, rooted at the run dir
      |
      |  every semantic call
      v
+------------------------------+
|          devin -p            |
|       << LLM BRAIN >>        |
|                              |
|  proposes candidate themes   |
|  compares treatment per      |
|  theme, with citations       |
|  returns JSON, never writes  |
+---------------+--------------+
                |
                |  untrusted until schema + citations validated
                +--------->  back to COORDINATOR
```

Supporting: `pdfjs-dist` for PDF extraction with page boundaries, `quickjs-emscripten` for the scoped REPL, `commander` for the CLI.

Fixtures are real, public, English-language UAE sources — primarily CBUAE AML/CFT material — pinned by URL, publication metadata, and SHA-256 so tests never hit the network.

Tests run at three levels: deterministic unit tests, mocked-agent integration tests, and a mandatory real-agent sanity suite that asserts invariants (valid schema, verified citations, required concepts, coverage and materiality thresholds, audit records) rather than snapshotting model prose.

## Planned interface

```bash
reg-compare doctor                      # preflight: node, npm, devin CLI + auth, quickjs

reg-compare run \
  --profile consultation-impact \
  --baseline ./documents/current-aml-guidance.pdf \
  --candidate ./documents/proposed-rule.pdf \
  --data-classification public \
  --output ./runs/aml-consultation

reg-compare validate --run ./runs/aml-consultation   # re-check a run, no agent calls
reg-compare inspect  --run ./runs/aml-consultation   # summarize a run
```

## Current state

| | |
| --- | --- |
| Specification | [SPEC.md](./SPEC.md) — approved build spec, v0.2 |
| Decision log | [DECISIONS.md](./DECISIONS.md) |
| Implementation | foundations in progress |

Technical spikes must clear before the core is called complete (SPEC §16): reliable structured output from `devin -p`, QuickJS embedding without leaking Node capabilities, PDF page/quote stability good enough for exact citation verification, and public-source redistribution rights. If a spike fails, the rule is to stop at that boundary and revise the spec — not to quietly weaken the security or evidence guarantees.

> **Note:** SPEC.md §11 still describes Devin as a sandboxed worker harness with disposable scratch workspaces and one-JSON-object-on-stdout contracts. That framing is superseded by the architecture above and needs revision.
