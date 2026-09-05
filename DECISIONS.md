# Regulatory Comparison Harness — Decision Log

## Purpose

Build a TypeScript CLI harness for thematic comparison of regulatory documents. The first corpus targets UAE financial-services AML/CFT material. It compares documents by regulatory theme and evidence, not by line diff.

## Supported comparison profiles

The CLI supports four profiles through a shared comparison engine:

1. `consultation-impact` — assess an official UAE consultation against current material.
2. `version-change` — assess material thematic changes between versions of a regulation.
3. `cross-guidance` — reconcile different guidance documents that address a common topic.
4. `policy-gap` — compare external requirements with a publicly disclosed corporate policy posture.

All profiles use a common finding schema with typed profile-specific assessment fields.

## CLI inputs and outputs

- Inputs are local `.pdf`, `.md`, and `.txt` documents.
- Version one supports English-language sources only.
- A run produces both canonical `analysis.json` and a reviewer-facing `report.md`.
- Each run has a self-contained evidence ledger with immutable artifacts plus a coordinator-owned mutable state projection, source snapshots, normalization outputs, plans, worker results, audit records, review decisions, logs, and final outputs.

## Human-in-the-loop workflow

Interactive runs have two required terminal review gates:

1. Plan approval, after theme discovery and before theme analysis.
2. Final approval, after findings are triaged and before final output publication.

Reviewers can approve, reject, or submit free-text amendments. Decisions and amendments are persisted in the run workspace. A non-interactive auto-approval path is required for automated tests.

## Agent topology

- TypeScript coordinates workflow state, HITL, validation, retries, and rendering.
- One read-only `devin -p` mapper discovers theme candidates.
- The plan is constrained to six themes by default.
- Each approved theme receives its own isolated `devin -p` comparison worker.
- Two theme workers run concurrently by default; test runs use one worker for repeatability.
- The evidence audit is deterministic and can use QuickJS; report rendering is deterministic from validated JSON.

## Devin CLI contract

- `devin -p` is the primary LLM reasoning engine and is also used in sanity tests.
- Workers receive coordinator-built, bounded context packets and emit exactly one JSON object through stdout.
- The TypeScript coordinator alone writes durable run artifacts and rejects invalid worker output.
- Workers run sandboxed from disposable, isolated scratch workspaces. Complete sources and the durable run workspace are denied; only materialized packet input is exposed. Unsandboxed fallback is forbidden.

## Context offloading and QuickJS execution

- The run workspace is the shared agent knowledge base.
- QuickJS is the only code-execution environment exposed to the workflow.
- Theme workers and the evidence-audit stage can invoke the scoped QuickJS REPL.
- The REPL exposes allowlisted read/write/list artifact operations only within the current run context. It has no shell, process, arbitrary filesystem, or network access.
- Every QuickJS program, result, and error is stored as an audit artifact.

## Evidence, results, and failure handling

- Every material finding needs one or more verified, exact source excerpts.
- Citations include document ID, normalized artifact path, PDF page or text/Markdown line range, section heading when available, and a short quote.
- Citation validation confirms the quoted excerpt exists at its stated locator before synthesis.
- Findings are classified as `critical`, `high`, `medium`, `low`, or `no_material_change`.
- Critical and high action candidates require an explicit reviewer disposition at final review.
- A failed worker receives one corrective retry. A second failure blocks finalization unless a reviewer explicitly approves a partial result.

## Data handling

- `--data-classification` is required and defaults to `public`.
- `internal` and `confidential` inputs require `--confirm-external-agent-access`.
- The declaration and acknowledgement are retained in the run manifest.

## Test contract

- The repository uses npm and Node.js 22.
- `npm test` runs unit tests, mocked integration tests, and authenticated real `devin -p` sanity tests.
- Missing or unauthenticated Devin CLI is a test failure, never a skipped check.
- Sanity tests assert invariant manifests: valid schemas, verified citations, expected concepts, coverage/materiality thresholds, HITL audit records, and final reports. They do not snapshot model prose byte-for-byte.

## Initial fixture corpus

- Use real public English-language UAE sources.
- The primary domain is CBUAE AML/CFT.
- The consultation-impact fixture must use a genuine UAE regulator consultation, using DFSA or ADGM when CBUAE has no suitable public consultation.
- The policy-gap fixture uses a real public corporate policy/disclosure and must identify results as analysis of public policy posture, not a complete internal control assessment.
- Sources will be pinned with publication metadata, source URL, and SHA-256 hashes so normal test runs do not download live content.

## Implementation defaults

The following are implementation defaults derived from the decisions above and can be changed without changing the core architecture:

- Runs are written beneath `runs/<timestamp>-<profile>/` unless `--output` is supplied.
- `--max-themes` defaults to `6`; `--concurrency` defaults to `2` and is capped at `3`.
- Citations use short excerpts to avoid reproducing large portions of source documents.
- A setup command will verify Node, npm, Devin CLI availability/authentication, and sandbox support before a real analysis begins.
