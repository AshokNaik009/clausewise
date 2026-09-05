# Regulatory Document Comparison Harness
## Product and Technical Specification

**Status:** Approved build specification  
**Version:** 0.2  
**Runtime:** TypeScript on Node.js 22 and npm  
**Primary reasoning engine:** Devin CLI in non-interactive `-p` mode  
**Initial regulatory corpus:** English-language UAE financial-services AML/CFT sources

---

## 1. Purpose

`reg-compare` is a local command-line harness that compares two regulatory documents **by theme and evidence**, not by line diff. It helps a compliance analyst identify material differences, draft actions, and policy gaps while retaining a reviewable evidence package.

A comparison is advisory analysis, not legal advice, a compliance determination, or a replacement for qualified legal/compliance review.

The design intentionally demonstrates four Deep Agents capabilities under auditable controls:

1. **Planning and HITL:** a reviewer approves analysis scope and dispositions.
2. **Subagent delegation:** a mapper proposes themes, then isolated workers analyze each approved theme.
3. **Filesystem context offloading:** an event-backed run directory is the shared, durable evidence package.
4. **Code execution:** a capability-scoped QuickJS REPL is available through a defined broker protocol.

---

## 2. Scope and non-goals

### 2.1 In scope

- Local `.pdf`, `.md`, and `.txt` inputs in English.
- Four profiles sharing one workflow and result envelope:
  - `consultation-impact`
  - `version-change`
  - `cross-guidance`
  - `policy-gap`
- `analysis.json` and `report.md` after reviewer approval.
- Real public UAE fixture metadata and pinned source snapshots where redistribution is permitted.
- Devin-driven semantic mapping and theme comparison, with deterministic TypeScript validation and report rendering.

### 2.2 Out of scope

- Downloading source documents during an ordinary analysis run.
- OCR, translation, GRC/case-management integration, regulatory submissions, or source-document modification.
- Unbounded document analysis, unrestricted shell execution, or unrestricted network access by a worker.
- A claim that a public corporate policy/disclosure represents the complete internal control environment of that organization.

---

## 3. Regulatory comparison profiles

| Profile | `baseline` | `candidate` | Required assessment fields |
| --- | --- | --- | --- |
| `consultation-impact` | Current binding rule or guidance. | Official UAE financial-regulator consultation. | `proposal_status`, `affected_obligation`, `implementation_consideration` |
| `version-change` | Earlier version of an instrument. | Later version of the instrument. | `change_type`, `effective_or_publication_context` |
| `cross-guidance` | First guidance source. | Second guidance source. | `relationship`, `scope_comparison` |
| `policy-gap` | External regulation or guidance. | Public corporate policy/disclosure. | `gap_status`, `public_policy_limitation` |

For `policy-gap`, the exact sentence below **must appear immediately after the report title and metadata table**:

> This analysis compares an external requirement with publicly disclosed policy posture only. It is not evidence of the organization’s complete internal control environment.

---

## 4. Operational limits and budgets

Limits are enforced before an agent worker is started. The defaults are intentionally conservative and must be shown in `reg-compare run --help`.

| Control | Default | Allowed range | Failure behavior |
| --- | ---:| ---:| --- |
| `--max-themes` | 6 | 1–6 | Reject an out-of-range value. |
| `--concurrency` | 2 | 1–3 | Reject an out-of-range value. |
| `--agent-call-budget` | 9 | 2–14 | Stop scheduling when exhausted; do not silently exceed it. |
| `--agent-timeout-seconds` | 300 | 30–900 | Kill the worker, record timeout, and apply retry policy. |
| `--max-source-pages` | 350 | 1–350 | Reject a larger PDF; never silently truncate pages. |
| `--max-source-chars` | 2,500,000/document | 10,000–2,500,000 | Reject a larger normalized document; never silently truncate text. |
| Mapper context | 160,000 canonical characters total | fixed v0.2 | Create a bounded mapping packet and report its coverage. |
| Theme context | 100,000 canonical characters total | fixed v0.2 | Create a bounded per-theme packet and report its coverage. |
| Theme context records | 80 records total | fixed v0.2 | Retrieval stops at the first applicable limit. |
| Worker stdout | 1 MiB | fixed v0.2 | Kill/mark malformed if the cap is exceeded. |
| Worker stderr | 1 MiB | fixed v0.2 | Truncate, flag `stderr_truncated`, and retain the captured prefix. |
| QuickJS source | 16 KiB | fixed v0.2 | Reject the request. |
| QuickJS RPC message | 128 KiB | fixed v0.2 | Reject the request. |
| QuickJS read result | 1 MiB/execution | fixed v0.2 | Reject the request. |
| QuickJS wall-clock time | 1,000 ms | fixed v0.2 | Interrupt the runtime and log `timeout`. |
| QuickJS memory | 32 MiB | fixed v0.2 | Interrupt/dispose the runtime and log `memory_limit`. |
| QuickJS stack | 1 MiB | fixed v0.2 | Interrupt/dispose the runtime and log `stack_limit`. |

The agent-call budget includes mapper attempts, theme attempts, corrective retries, and semantic plan-remapping attempts. It is not a cost estimate; Devin CLI does not expose a stable token-cost contract to this application. The CLI reports the number of calls used, calls remaining, and the maximum possible remaining calls at every review gate.

---

## 5. Command-line interface

```text
reg-compare --version
reg-compare doctor [--json]
reg-compare run [options]
reg-compare resume --run <directory> [--auto-approve]
reg-compare validate --run <directory> [--json]
reg-compare inspect --run <directory> [--json]
reg-compare fixtures verify [--json]
reg-compare fixtures fetch --id <fixture-id> --confirm-public-download
reg-compare purge --run <directory> --confirm-purge
```

### 5.1 `run`

```bash
reg-compare run \
  --profile consultation-impact \
  --baseline ./documents/current-aml-guidance.pdf \
  --candidate ./documents/proposed-rule.pdf \
  --data-classification public \
  --output ./runs/aml-consultation
```

Required arguments:

- `--profile <consultation-impact|version-change|cross-guidance|policy-gap>`
- `--baseline <path>`
- `--candidate <path>`
- `--data-classification <public|internal|confidential>`; default is `public`

Optional arguments:

- `--output <new-directory>`; default: `runs/<UTC timestamp>-<profile>/`
- `--max-themes <1..6>`
- `--concurrency <1..3>`
- `--agent-call-budget <2..14>`
- `--agent-timeout-seconds <30..900>`
- `--max-source-pages <1..350>`
- `--max-source-chars <10000..2500000>`
- `--allow-partial`
- `--auto-approve`
- `--confirm-external-agent-access`; required for `internal` and `confidential`
- `--confirm-encrypted-workspace`; required for `confidential`
- `--retention-until <ISO-8601 timestamp>`; required for `confidential`, maximum 30 days in the future
- `--dry-run`; validates inputs, normalizes, calculates context/call budgets, and prints the execution plan without calling Devin or creating a durable run directory

Rules:

- Source files must be distinct regular files with supported extensions.
- The output directory must not exist. `resume` is the only command that accepts an existing run directory.
- `--auto-approve --allow-partial` is invalid. A partial finalization always needs an interactive, explicit human confirmation.
- An approved plan cannot select more themes than both `--max-themes` and the remaining call budget can support.
- `doctor`-equivalent preflight runs before any Devin process is started.

### 5.2 `doctor`

`doctor` is non-destructive. It verifies Node 22, npm, the QuickJS runtime, the discoverable Devin CLI version, authenticated Devin access, supported Devin `-p`/sandbox flags, the required worker-policy configuration, and effective sandbox availability. It prints the active limits and exits non-zero when any required capability is absent.

`doctor` validates policy configuration; it does not claim to prove the availability or security of an external Devin transport service.

### 5.3 `resume`

`resume` continues a valid interrupted or review-blocked run from its last safe state. It never recreates accepted worker artifacts and never reuses an in-flight worker. A worker active at interruption is recorded as `abandoned`; a resumed run schedules a fresh attempt only if the call budget permits it.

### 5.4 Exit codes

| Code | Meaning |
| ---:| --- |
| 0 | Requested operation completed successfully; a `run` is complete and finalized. |
| 1 | Invalid CLI usage or input argument. |
| 2 | Preflight, policy, authentication, sandbox, classification, or source-ingestion failure. |
| 3 | Schema, evidence, report-consistency, or run-ledger validation failure. |
| 4 | Run finalized as an explicitly approved **partial** result. |
| 5 | A worker, mapper, budget, or required review blocked completion. |
| 6 | Run is corrupt or cannot be resumed safely. |
| 7 | Devin-driven sanity test failed. |
| 130 | Interrupted by `SIGINT`. |
| 143 | Interrupted by `SIGTERM`. |

`inspect --json`, `validate --json`, and `doctor --json` emit exactly one JSON object to stdout. Human-readable `inspect` is not a machine contract.

---

## 6. Source acceptance, language, and privacy controls

### 6.1 PDF quality gate

A PDF is accepted only if all of these are true after extraction and canonicalization:

- Page count is within the configured page cap.
- Canonical character count is within the configured character cap and at least `max(1,000, 200 × page_count)`.
- At least 80% of pages contain 100 or more canonical non-whitespace characters.

A PDF failing any rule is rejected as `needs_ocr` or `source_too_large`; v0.2 does not perform OCR and does not continue with a sparse extraction. An operator must provide an OCRed PDF or an approved text/Markdown transcription.

### 6.2 Language gate

The system supports English only. It samples the first 20,000 canonical alphabetic characters of each source:

- Reject as `unsupported_language` if Arabic-script characters exceed 1% of sampled alphabetic characters.
- Reject as `unsupported_language` if Latin-script characters are below 70% of sampled alphabetic characters.
- Otherwise record `language: "en"` and the observed script ratios in `source-stats.json`.

The strict Arabic threshold deliberately rejects mixed Arabic/English material rather than translating or presenting it as English-only analysis.

### 6.3 Classification and storage

- `public` uses the normal workspace layout.
- `internal` requires `--confirm-external-agent-access`.
- `confidential` requires both `--confirm-external-agent-access` and `--confirm-encrypted-workspace`, plus a `--retention-until` no more than 30 days ahead.

For every run, the coordinator sets process `umask` to `0077`, creates directories with mode `0700`, and creates files with mode `0600`. It verifies these modes after creation and fails closed if the platform cannot provide them.

The tool cannot independently prove that a filesystem is encrypted. `--confirm-encrypted-workspace` is an auditable operator assertion that the selected output root is on an organization-approved encrypted volume. The application never prints source text, citations, prompts, or agent stdout to its own terminal logs by default.

`purge` is the sole cleanup command. It requires an explicit `--confirm-purge` for that exact run and records a purge intent event before deleting. No automatic deletion or claimed secure-erasure guarantee exists in v0.2.

---

## 7. Canonical normalization and record contract

### 7.1 Canonicalization version `canon-v1`

The extractor preserves `raw_text` from the parser and derives `canonical_text` deterministically. The same `canon-v1` function is used by ingestion, retrieval, worker prompts, QuickJS validation, and citation audit.

For each extracted text line, `canon-v1` performs exactly these steps, in order:

1. Decode as UTF-8; malformed input is rejected, not replaced.
2. Apply Unicode NFKC normalization.
3. Remove U+00AD (soft hyphen), U+200B, U+200C, U+200D, and U+FEFF.
4. Convert CRLF and CR to LF.
5. Convert every Unicode whitespace code point except LF to U+0020 SPACE.
6. Collapse consecutive U+0020 SPACE characters to one U+0020 SPACE and trim leading/trailing U+0020 SPACE.
7. Preserve record boundaries as exactly one LF when records are concatenated.

The function does **not** dehyphenate `-\n`, reorder columns, infer reading order, merge records, translate text, correct OCR, or remove punctuation. PDF reading order is therefore the extractor’s declared order and is recorded in `source-stats.json`.

### 7.2 Normalized document schema

`sources/normalized/<document-id>.json` conforms to this schema:

```json
{
  "schema_version": "1.0",
  "canonicalization_version": "canon-v1",
  "document_id": "baseline",
  "format": "pdf",
  "records": [
    {
      "record_id": "baseline:p0012:l0003",
      "ordinal": 243,
      "page": 12,
      "page_line": 3,
      "global_line": 243,
      "heading": "Customer due diligence",
      "raw_text": "Parser output for this extracted line",
      "canonical_text": "Parser output for this extracted line",
      "source_order": { "page": 12, "page_line": 3 }
    }
  ]
}
```

For Markdown/text inputs, `page` and `page_line` are `null`; `global_line` is the original one-based physical input line number. For PDFs, `global_line` is a one-based counter across pages in `source_order`; `page_line` resets to one at every page. `ordinal` is a one-based sequential record number and always equals `global_line` in v0.2.

Records are ordered strictly by `ordinal` ascending. `record_id` is coordinator-generated and immutable. It uses only the pattern `baseline|candidate:p[0-9]{4}:l[0-9]{6}` and is never used as a filesystem path.

### 7.3 Citation matching

A worker emits a **citation claim**, never an already verified citation:

```json
{
  "document_id": "baseline",
  "start_record_id": "baseline:p0012:l0003",
  "end_record_id": "baseline:p0012:l0005",
  "excerpt": "Exact canon-v1 text copied from the supplied context packet."
}
```

The coordinator validates a claim as follows:

1. Resolve both record IDs within the named normalized document and reject cross-document or reversed ranges.
2. Concatenate inclusive `canonical_text` values with exactly one LF.
3. Apply `canon-v1` to `excerpt`. The result must equal the supplied `excerpt`; otherwise the worker did not supply canonical text and the claim is rejected.
4. Require `excerpt` to be a non-empty contiguous substring of the resolved canonical span.
5. Derive, rather than accept, `page_start`, `page_end`, `global_line_start`, `global_line_end`, headings, and `excerpt_sha256`.

A validated citation is coordinator-owned and includes `verified: true`. Worker output cannot set or influence that field. Quotes are canonical text; this is the only matching semantics used by the system.

---

## 8. Data schemas and ownership

All schemas are implemented as discriminated TypeScript/Zod schemas. `validate` checks every durable JSON artifact against its named schema version.

### 8.1 `DocumentRef`

```json
{
  "document_id": "baseline",
  "display_name": "current-aml-guidance.pdf",
  "format": "pdf | markdown | text",
  "language": "en",
  "raw_artifact_path": "sources/raw/baseline.pdf",
  "normalized_artifact_path": "sources/normalized/baseline.json",
  "sha256": "hex digest",
  "page_count": 42,
  "record_count": 904,
  "canonicalization_version": "canon-v1"
}
```

### 8.2 Immutable manifest, events, state projection, and logs

Every JSON artifact has `schema_version: "1.0"` and a `created_at` timestamp. `manifest.json` is immutable:

```json
{
  "schema_version": "1.0",
  "run_id": "uuid",
  "created_at": "ISO-8601",
  "profile": "consultation-impact",
  "options": { "max_themes": 6, "concurrency": 2, "agent_call_budget": 9 },
  "data_classification": "public | internal | confidential",
  "documents": ["DocumentRef", "DocumentRef"],
  "normalization_version": "canon-v1"
}
```

Every immutable `events/<sequence>-<type>.json` entry is an `Event`:

```json
{
  "schema_version": "1.0",
  "run_id": "uuid",
  "sequence": 12,
  "type": "state_transition | artifact_created | worker_started | worker_finished | review_recorded | interrupted",
  "timestamp": "ISO-8601",
  "actor": "coordinator | reviewer | worker",
  "payload": {},
  "previous_event_sha256": "hex digest | null"
}
```

`run-state.json` is the coordinator-only atomic projection `{ run_id, state, updated_at, active_plan_path, active_review_stage, used_agent_calls, remaining_agent_calls, worker_statuses, final_artifact_paths, last_event_sequence }`. It is reconstructed from `events/` during validation.

`logs/events.ndjson` is a byte-for-byte NDJSON mirror of immutable event payloads for streaming readers. `logs/orchestrator.ndjson` is non-authoritative operational telemetry with `{ timestamp, level, stage, event, message, fields }`; it must not contain source text, full prompts, or raw worker stdout.

### 8.3 Mapper proposal and approved plan

The mapper emits `MapperProposal`; it contains no coordinator identifiers, paths, or verification values:

```json
{
  "schema_version": "1.0",
  "proposals": [
    {
      "label": "Customer due diligence",
      "description": "How the documents define and apply CDD obligations.",
      "keywords": ["CDD", "customer", "due diligence"],
      "ranking_rationale": "Both sources contain CDD sections.",
      "seed_record_ids": ["baseline:p0012:l0003", "candidate:p0008:l0002"]
    }
  ]
}
```

The coordinator validates every seed record ID, de-duplicates proposals, and assigns theme IDs in plan order. Theme IDs are lowercase ASCII and match `thm-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+){0,8}`. Worker artifact paths use only `workers/thm-<NNN>/`, never mapper-supplied strings.

`planning/plan-<round>.json` is `ApprovedPlan`:

```json
{
  "schema_version": "1.0",
  "plan_id": "plan-uuid",
  "round": 1,
  "mapper_artifact_path": "planning/mapper-result-1.json",
  "themes": [
    {
      "theme_id": "thm-001-customer-due-diligence",
      "label": "Customer due diligence",
      "description": "string",
      "keywords": ["string"],
      "seed_record_ids": ["baseline:p0012:l0003"],
      "context_packet_path": "context/thm-001/packet.json"
    }
  ],
  "limits": { "max_themes": 6, "theme_context_chars": 100000, "theme_context_records": 80 },
  "call_budget": { "used": 1, "remaining": 8, "maximum_remaining": 8 },
  "payload_sha256": "hex digest"
}
```

Only a plan with a matching approved `ReviewRecord` may become `active_plan_path` in `run-state.json`.

### 8.4 Worker, citation, theme, and finding schemas

A worker emits `ThemeWorkerResult`:

```json
{
  "schema_version": "1.0",
  "outcome": "assessed | no_material_change | not_assessable",
  "outcome_rationale": "string",
  "candidate_findings": [
    {
      "title": "string",
      "summary": "string",
      "materiality": "critical | high | medium | low | no_material_change",
      "materiality_rationale": "string",
      "confidence": "high | medium | low",
      "citation_claims": ["CitationClaim"],
      "action_candidate": { "description": "string", "action_type": "assess | implement | monitor | respond | validate" },
      "profile_assessment": {}
    }
  ]
}
```

`CitationClaim` has exactly `document_id`, `start_record_id`, `end_record_id`, and `excerpt` as defined in section 7.3. It has no `verified` field. The coordinator derives a `VerifiedCitation` with those fields plus `page_start`, `page_end`, `global_line_start`, `global_line_end`, `heading_start`, `heading_end`, `excerpt_sha256`, and `verified: true`.

The coordinator creates `ThemeResult` after audit:

```json
{
  "theme_id": "thm-001-customer-due-diligence",
  "label": "Customer due diligence",
  "status": "complete | degraded | excluded",
  "outcome": "assessed | no_material_change | not_assessable",
  "attempt_artifacts": ["workers/thm-001/attempt-1.json"],
  "context_packet_path": "context/thm-001/packet.json",
  "findings": ["Finding"],
  "rejected_finding_references": ["audit/rejected-findings-1.json"],
  "coverage": { "included_records": 38, "candidate_records": 71, "context_truncated": false }
}
```

Finding IDs are assigned only after audit in deterministic plan/theme/worker-result order as `F-0001`, `F-0002`, and so on. Their uniqueness scope is one `run_id`.

A final `Finding` is `{ id, theme_id, title, summary, materiality, materiality_rationale, confidence, evidence: VerifiedCitation[], action_candidate: ActionCandidate | null, profile_assessment: ProfileAssessment }`. `ActionCandidate` is coordinator-enriched after final review as `{ description, action_type, review_disposition }`.

`critical` and `high` findings require a non-null worker `action_candidate`; `not_required` is invalid for them. `medium` and `low` findings may use `action_candidate: null` or receive `not_required`. `no_material_change` requires `action_candidate: null` and two verified scope citations, one from each source.

A **material finding** is `critical`, `high`, `medium`, or `low`. Every published finding, including `no_material_change`, requires verified evidence; the latter uses scope citations rather than a claimed regulatory change.

`ProfileAssessment` is discriminated by the run profile:

```text
consultation-impact: { proposal_status: new|amends|removes|clarifies, affected_obligation, implementation_consideration }
version-change:      { change_type: added|modified|removed|clarified, effective_or_publication_context }
cross-guidance:      { relationship: aligns|adds_detail|scope_difference|conflicts, scope_comparison }
policy-gap:          { gap_status: gap|partial_alignment|aligned|not_assessable, public_policy_limitation }
```

### 8.5 Review records

`reviews/plan-<round>.json`, `reviews/final-<round>.json`, and `reviews/partial-<round>.json` use `ReviewRecord`:

```json
{
  "schema_version": "1.0",
  "review_id": "review-uuid",
  "stage": "plan | final | partial",
  "round": 1,
  "mode": "interactive | automation",
  "actor": "local-user | automation",
  "decision": "approved | rejected | amended | confirmed_partial",
  "amendment": "string | null",
  "dispositions": [
    { "finding_id": "F-0001", "value": "accepted | deferred | rejected | needs_evidence" }
  ],
  "timestamp": "ISO-8601"
}
```

The final review rejects a finalization when a critical/high finding lacks one of the four listed dispositions. A `not_required` disposition cannot satisfy the final gate for a critical/high finding.

### 8.6 Source, audit, coverage, and QuickJS artifacts

`source-stats.json` is `{ document_id, page_count, record_count, canonical_character_count, textual_page_count, textual_page_ratio, script_ratios, extraction_order, quality_gate }`.

`citation-audit-<round>.json` is `{ audit_round, claims: [{ claim_reference, finding_reference, outcome: accepted|rejected, reason_code, derived_citation, fingerprint }], duplicate_decisions }`.

`rejected-findings-<round>.json` is `{ audit_round, rejected: [{ worker_artifact_path, candidate_index, reason_codes, escalates_theme_failure }] }`.

`coverage-<round>.json` is `{ ingestion_page_ratio, mapper_heading_ratio, mapper_body_sample_ratio, theme_outcome_ratio, verified_finding_ratio, fixture_required_concept_ratio, per_theme }`.

`quickjs/<execution-id>.json` is `{ execution_id, timestamp, caller_role, theme_id, capability_hash, allowed_reads, allowed_writes, script_sha256, script, duration_ms, result, error, resource_outcome, written_artifacts }`.

---

## 9. Run workspace, events, and resumability

A run is an **append-only evidence ledger plus one mutable coordinator-owned state projection**. It is not inaccurately described as entirely append-only.

```text
<run-directory>/
├── manifest.json                         # write once
├── run-state.json                        # mutable atomic projection; coordinator only
├── lock                                  # held only while a run/resume is active
├── events/000001-run-created.json        # immutable ordered event ledger
├── logs/
│   ├── orchestrator.ndjson                # operational logs; not authoritative state
│   └── events.ndjson                      # event stream mirror; same payload as events/
├── sources/{raw,normalized}/
├── planning/{mapper-*,plan-<round>.json}/
├── context/{mapper,thm-001,...}/          # coordinator-built bounded packets
├── reviews/{plan-<round>,final-<round>,partial-<round>}.json
├── workers/thm-001/{attempt-<n>-*}
├── quickjs/<execution-id>.json
├── audit/{citation-audit,rejected-findings,coverage}-<round>.json
├── drafts/draft-analysis-<round>.json
├── analysis.json                          # write once, after finalization
└── report.md                              # write once, after finalization
```

`manifest.json` is written once at creation and contains immutable options, source hashes, classification declarations, and schema versions. It does not hold mutable status.

`run-state.json` is the only mutable artifact. It is written atomically by the coordinator after appending an event and contains the current state, active plan reference, used/remaining call budget, worker status table, active review gate, and final artifact references. `inspect` reads this projection. `validate` reconstructs expected state from the immutable event ledger and reports `corrupt` if it disagrees with `run-state.json`.

`drafts/draft-analysis-<round>.json` is immutable; a new draft gets a new round number. `analysis.json` and `report.md` are created exactly once when state becomes `finalized`.

### 9.1 State machine

```text
created -> ingesting -> normalized -> mapping -> awaiting_plan_review
awaiting_plan_review -> mapping                 (one approved semantic amendment round only)
awaiting_plan_review -> analyzing -> auditing -> awaiting_final_review -> finalized
any non-final state -> interrupted
worker failure -> retrying | blocked_partial | failed
blocked_partial -> awaiting_partial_review -> finalized
awaiting_*_review -> cancelled                  (reviewer rejection)
```

State-to-output mapping:

| Run state | `analysis.json` / `report.md` | Final envelope `completion_status` |
| --- | --- | --- |
| Any pre-final state, `failed`, `cancelled`, `interrupted`, `blocked_partial` | Absent | Not applicable |
| `finalized` with no excluded theme | Present | `complete` |
| `finalized` after confirmed partial review | Present | `partial` |

The final envelope has structured exclusions:

```json
{
  "completion_status": "complete | partial",
  "excluded_themes": [
    {
      "theme_id": "thm-003-record-keeping",
      "reason_code": "worker_retry_exhausted | call_budget_exhausted | reviewer_excluded",
      "attempt_artifacts": ["workers/thm-003/attempt-1.json"],
      "description": "string"
    }
  ]
}
```

### 9.2 Interrupt handling

On `SIGINT` or `SIGTERM`, the coordinator stops scheduling work, terminates active child processes, appends an `interrupted` event, atomically projects `run-state.json`, releases the lock, and exits 130 or 143. Accepted artifacts remain valid. `resume` performs ledger validation and re-enters the last safe state; it does not discard completed mapper/theme/audit work or require re-review of an already approved plan.

---

## 10. Context slicing and retrieval

Workers never receive a durable-run root path or unrestricted normalized documents. The coordinator builds immutable context packets before each invocation.

### 10.1 Mapper packet

`context/mapper/packet.json` contains:

- a document index of all headings, pages, global-line ranges, record IDs, and canonical character counts;
- a deterministic stratified sample of body records from both documents;
- a sample-coverage manifest;
- profile instructions and a restricted output schema.

The mapper packet is capped at 160,000 canonical characters in total. The sampler includes every detected top-level heading in the index, then selects body records by: seed/heading coverage first, regulatory-obligation marker score second, and document-order round robin third. It never omits an entire detected top-level heading from the index, although its body text may be unsampled.

### 10.2 Theme packet

For each approved theme, the coordinator builds `context/<theme-id>/packet.json` from:

- the approved theme label, description, keywords, and mapper seed records;
- BM25-style lexical retrieval over canonical records using those terms;
- a two-record neighborhood around each selected record;
- a diversity cap of four selected records per heading/page region;
- at least four records from each source when available.

Selection ends at 80 records or 100,000 canonical characters across both sources, whichever occurs first. The packet records included and excluded candidate record IDs, per-document count/character coverage, the approximate token estimate `ceil(canonical_characters / 4)`, and whether context was truncated.

If fewer than four relevant records exist for either source, the worker receives the packet but can return `not_assessable`; it must not manufacture a comparison. A worker cannot request unbounded source expansion. Its QuickJS broker capability can read only the exact packet and allowed prior artifacts, not the full normalized documents.

### 10.3 Enforced view

The runner creates a disposable worker scratch directory and a worker-specific Devin policy. The policy denies direct reads of raw sources, complete normalized sources, planning artifacts outside the active plan, other workers, and the durable run root. The only source content exposed to the worker is its materialized context packet copied into the scratch input view.

This policy is verified by `doctor` and integration tests against the installed Devin CLI version. The context cap is both a performance control and an application-enforced worker-input contract; it must not be represented as an OS-wide confidentiality boundary.

---

## 11. Workflow, coverage, and retry semantics

### 11.1 Mapping and plan review

1. Ingest and normalize both documents.
2. Build the mapper packet and launch one mapper attempt.
3. Validate the mapper proposal and derive a bounded plan.
4. Present the plan, source/sample coverage, effective theme cap, call budget, and exclusions at the terminal gate.
5. The reviewer chooses `approve`, `reject`, or `amend <free text>`.

There are at most **two mapper invocations per run**. The two-call budget is shared:

- A technical mapper failure gets one corrective retry if no semantic amendment has consumed the second call.
- A first approved-plan amendment invokes one mapper revision and consumes the second call.
- A second semantic amendment is rejected as `plan_amendment_limit`; the reviewer may reject/cancel and start a new run.
- If the initial mapper attempt and its corrective retry fail, the run becomes `failed` before theme work starts.
- If a mapper revision after an amendment fails, the run becomes `failed`; no hidden third mapper call is allowed.

### 11.2 Theme workers

Approved themes run with the configured concurrency. The worker writes no durable state and returns exactly one `ThemeWorkerResult` JSON object on stdout. The runner captures stdout/stderr with the limits in section 4 and records prompt, command metadata, exit status, and timestamps.

### 11.3 Audit, rejection, and retry

The audit distinguishes worker-level and finding-level failure:

- **Worker-level failure:** timeout, non-zero exit, stdout cap exceeded, missing/invalid JSON, schema failure, unsafe output, or no publishable outcome after audit. It triggers one corrective retry, subject to the global call budget.
- **Finding-level rejection:** a structurally valid worker result includes one or more invalid citation claims. The auditor rejects only those findings, writes them to `rejected-findings`, and accepts independently valid findings from the same worker result.
- **Escalation:** if every candidate finding from a worker result is rejected, or its remaining accepted findings cannot satisfy the theme’s required outcome/evidence coverage, the theme becomes a worker-level failure and is retried once.

Thus one bad citation among ten does not discard nine valid findings, while a theme with no defensible output cannot silently pass.

### 11.4 Duplicate evidence

A citation fingerprint is:

```text
SHA-256(document_id + start_record_id + end_record_id + excerpt_sha256)
```

- Duplicate fingerprints within one finding are removed automatically and recorded as `deduplicated_within_finding`.
- Reuse across different findings is retained but recorded as `reused_across_findings`; it is not an error because one source passage can support multiple distinct claims.
- Two findings with the same theme ID, title after canonical comparison, materiality, profile assessment, and complete set of citation fingerprints are duplicate findings. The coordinator retains the first in deterministic order and rejects the later one as `duplicate_finding`.

### 11.5 Coverage metrics

`coverage-<round>.json` contains these normative metrics:

| Metric | Formula | Complete-run requirement |
| --- | --- | --- |
| `ingestion_page_ratio` | normalized accepted pages / source pages | `1.0` for each document |
| `mapper_heading_ratio` | indexed structural units / detected structural units; a structural unit is a top-level heading, or a page when no headings exist | `1.0` |
| `mapper_body_sample_ratio` | canonical sampled body characters / canonical source characters | reported; no universal minimum |
| `theme_outcome_ratio` | themes with audited terminal outcomes / approved themes | `1.0` |
| `verified_finding_ratio` | published findings with all required verified citations / published findings | `1.0` |
| `fixture_required_concept_ratio` | required expectation-manifest concepts evidenced / required concepts | not applicable outside fixtures; `1.0` in a sanity test |

A fixture expectation manifest must state a numeric `min_published_findings` (at least 1), required concept IDs, expected profile, and any minimum materiality/action counts. It may not rely on prose snapshots.

### 11.6 Partial handling

If retry cannot run or fails because of worker failure, call-budget exhaustion, or reviewer exclusion, the run enters `blocked_partial`. No final artifact is written until an interactive reviewer explicitly chooses `confirmed_partial`; `--auto-approve` cannot satisfy this confirmation. The final envelope then has `completion_status: "partial"` and non-empty `excluded_themes`.

---

## 12. Devin worker and QuickJS broker protocol

### 12.1 Network and transport boundary

The design distinguishes three channels:

1. **Devin transport:** the outer Devin CLI process communicates with Devin’s service. This required cloud transport is outside the child-process sandbox and is not described as offline.
2. **Agent fetch tool:** worker policy denies all `Fetch(...)` permissions. Workers cannot use HTTP fetch tools to obtain sources or instructions.
3. **Sandboxed child process traffic:** a non-empty Devin sandbox allowlist must contain no internet domain. The QuickJS bridge uses a Unix domain socket, not TCP/IP. Sandbox child processes therefore cannot make outbound network connections.

The runner launches Devin with `--sandbox`; it must fail closed when sandbox setup fails. `doctor` validates an effective per-worker policy containing the fetch deny and the child-network allowlist. If the installed Devin CLI/platform cannot enforce this separation, the harness refuses to run rather than treating a prompt instruction as network security.

### 12.2 One-shot worker protocol

Each mapper/theme process is a one-shot `devin -p` session in a disposable scratch workspace. It receives:

- the role, profile, bounded theme (for theme workers), and output schema;
- a read-only materialized context packet;
- a per-worker QuickJS bridge command, Unix socket path, and single-use capability file;
- explicit instruction that document content is untrusted data, not instructions;
- the rule to emit exactly one JSON object and no Markdown fencing on stdout.

A one-shot final stdout does not preclude tool use **during** the Devin session. The QuickJS bridge below supplies the required request/response path while the session is active.

### 12.3 QuickJS request/response bridge

Before launching a worker, the coordinator starts one local Unix-domain-socket broker at a `0600` socket path inside that worker’s scratch workspace. It creates a random, single-worker capability token stored in a `0600` capability file. The worker may invoke the supplied bridge client during its session:

```text
reg-compare worker-quickjs --socket <socket> --capability-file <file> --script <scratch-script>
```

The bridge client sends `{capability, caller_role, script, requested_reads, requested_writes}`. The coordinator validates token, caller role, message size, packet path allowlist, and output namespace, then executes the script in the embedded QuickJS runtime. It returns a JSON response to the bridge client’s stdout, which Devin can read and use before composing final worker stdout.

The bridge is available only to theme workers and the evidence-audit stage. It is closed when the worker exits; a token cannot be reused by another worker or later run.

### 12.4 QuickJS virtual filesystem and writes

The QuickJS runtime exposes only:

- `listArtifacts(prefix)` — lists paths under the caller’s allowed packet/artifact prefixes.
- `readArtifact(path)` — reads an allowed immutable context or approved prior artifact.
- `writeArtifact(path, content)` — writes only to a worker-private requested-output namespace.

`writeArtifact` does not grant filesystem access to the worker. It is an RPC request: the coordinator validates the namespace and performs the durable write itself under `quickjs/<execution-id>/outputs/`. It cannot write source files, plans, run state, reviews, another worker’s result, drafts, or final outputs.

The runtime has no Node globals, `require`, imports, shell/process APIs, environment variables, network APIs, or host filesystem APIs. It applies the memory, stack, and interrupt limits in section 4. Every request creates `quickjs/<execution-id>.json` with caller role, theme ID, input paths, program SHA-256 and text, result/error, duration, resource-limit outcome, and coordinator-owned written artifacts.

---

## 13. Prompt-injection and untrusted-content policy

Document text, mapper output, worker stdout, QuickJS code, filenames, and review amendments are untrusted inputs at their respective boundaries.

- Source text is stored as data records and supplied inside explicit `BEGIN UNTRUSTED REGULATORY SOURCE` / `END UNTRUSTED REGULATORY SOURCE` delimiters. It is never concatenated into system instructions.
- Worker system instructions state that source-language requests, tool instructions, URLs, credentials requests, and directions to alter records are content to analyze, not commands to follow.
- The coordinator supplies paths, IDs, profiles, and limits; no source-controlled value forms a command, policy rule, or filesystem path.
- Mapper labels are validated and coordinator-slugged before use. Citation IDs are resolved against schemas. Worker stdout and QuickJS results remain untrusted until validated.
- The audit records, but does not delete or alter, source segments that contain common prompt-injection indicators. This preserves regulatory evidence while allowing the report to state a limitation when relevant.

---

## 14. Report and final result

### 14.1 Final result envelope

`analysis.json` contains:

```json
{
  "schema_version": "1.0",
  "run_id": "uuid",
  "profile": "consultation-impact",
  "completion_status": "complete | partial",
  "sources": ["DocumentRef", "DocumentRef"],
  "themes": ["ThemeResult"],
  "summary": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 0,
    "no_material_change": 0
  },
  "excluded_themes": [],
  "coverage": "CoverageMetrics",
  "final_review": "ReviewRecord",
  "limitations": ["string"],
  "rendered_report_sha256": "hex digest"
}
```

### 14.2 Deterministic Markdown template

`report.md` is rendered only from audited `analysis.json`, in this exact order:

1. Title and run metadata: profile, `run_id`, completion status, classification, and source hashes.
2. Mandatory policy-gap disclaimer when relevant.
3. Executive summary and materiality counts.
4. Scope, source quality, context limits, call budget, and coverage metrics.
5. Excluded themes and partial-run reasons, if any.
6. Theme findings ordered by materiality then plan order. Each includes summary, profile assessment, materiality rationale, action candidate/disposition, and rendered verified citations.
7. Final reviewer dispositions for critical/high actions.
8. Limitations, including public-policy posture limitations and detected injection signals.
9. Audit appendix with artifact references and report-render hash.

`validate` rerenders the report from `analysis.json`, compares the exact bytes and SHA-256, and verifies the required policy-gap disclaimer placement. A manually edited `report.md` is therefore reported as inconsistent rather than silently accepted.

---

## 15. Fixture lifecycle, testing, and CI cost controls

### 15.1 Fixture manifest

Every fixture entry records title, publisher/regulator, jurisdiction, status, publication date, original URL, source SHA-256, local path or fetch state, applicable profiles, license/terms review, and expectation-manifest path.

Normal runs and tests never download source URLs.

- Where terms permit redistribution, the immutable source snapshot is committed and `fixtures verify` checks its hash.
- Where terms do not permit redistribution, only manifest metadata and expected hash are committed. An operator invokes `fixtures fetch --id <id> --confirm-public-download`; the tool downloads into an ignored local cache, verifies the hash, and never stages the source for commit.
- A fixture refresh is a controlled maintenance operation: update source metadata/terms review, obtain a new snapshot, calculate a new hash, update expectations, and review the change. It is not performed by test execution.

The initial corpus prioritizes real public English-language CBUAE AML/CFT sources. The consultation fixture may use an official DFSA or ADGM consultation where CBUAE has no suitable public equivalent. A policy-gap fixture must carry the mandatory public-policy limitation.

### 15.2 Test tiers

```text
npm run test:unit
npm run test:integration
npm run test:sanity
npm run test:sanity:full
npm test
npm run build
```

- **Unit:** normalizer, schemas, context selection, state ledger, report renderer, limits, and QuickJS restrictions.
- **Integration:** mocked Devin runner, bridge protocol, retry behavior, interruption/resume, and policy enforcement.
- **`test:sanity`:** one small public fixture smoke case with real authenticated `devin -p`, `--auto-approve`, concurrency one, and a call budget of three (one mapper plus up to two theme workers). It is included in `npm test`.
- **`test:sanity:full`:** all four profile fixtures with their specified budgets; it is an explicit, more expensive command.

A sanity expectation manifest must require `fixture_required_concept_ratio: 1.0`, `verified_finding_ratio: 1.0`, `theme_outcome_ratio: 1.0`, and an explicit `min_published_findings >= 1`; it may add profile-specific materiality/action thresholds.

Missing/unavailable/un-authenticated Devin fails `npm test` immediately. A live sanity failure fails once and preserves artifacts; there is no automatic rerun that hides flakes. A fixture may be quarantined only by a reviewed manifest change containing an owner, reason, creation date, and expiry date. A quarantined fixture is excluded only from `test:sanity:full`; it is never silently excluded from the smoke case.

### 15.3 Definition of done

The release is complete only when:

1. All commands and exit-code behavior in section 5 are implemented.
2. The schemas, normalizer, packet limits, and state projection are enforced by tests.
3. Every worker uses the scoped scratch/policy/packet contract and the QuickJS bridge is integration-tested.
4. Invalid citation claims cannot reach either final artifact.
5. Partial outcomes are structured and cannot be auto-approved.
6. Interrupted runs resume without redoing accepted work.
7. PDF quality/language gates fail closed.
8. Public/internal/confidential workspace controls and file modes are verified.
9. Fixture manifest lifecycle and non-redistributable fallback work.
10. `npm test` and `npm run build` pass in a configured environment; full fixture agent testing passes outside an approved, time-bounded quarantine.

---

## 16. Required implementation spikes

Before enabling a production-like real-agent run, engineering must verify and test:

1. The installed Devin CLI honors the generated worker `Read(...)` deny rules and sandbox rules when launched from a disposable scratch workspace.
2. The effective policy blocks `Fetch(...)` and sandbox child-process egress while preserving required outer Devin service transport.
3. `devin -p` reliably returns one bounded JSON output under the worker contract; malformed output is captured and retried exactly as specified.
4. `quickjs-emscripten` enforces the configured memory/stack/interrupt limits and cannot access Node capabilities through the bridge.
5. The selected PDF extractor produces stable page/line ordering and `canon-v1` citations for the actual UAE fixture PDFs.
6. Public source terms permit each committed snapshot; otherwise the manifest-plus-operator-fetch fallback is used.

A failed spike blocks the affected feature. The implementation must revise this specification or refuse the run; it must not quietly weaken evidence, isolation, network, or data-protection guarantees.
