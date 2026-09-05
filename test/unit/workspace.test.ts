import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, createWorkspace, reserveModelCall, transitionState, validateLedger } from "../../src/workspace.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const workspaceManifest = {
  profile: "version-change" as const,
  data_classification: "public" as const,
  options: {
    profile: "version-change" as const,
    dataClassification: "public" as const,
    maxThemes: 1,
    concurrency: 1,
    agentCallBudget: 2,
    agentTimeoutSeconds: 30,
    maxSourcePages: 1,
    maxSourceChars: 10_000,
    allowPartial: false,
    autoApprove: true,
    confirmExternalModelAccess: false,
    confirmEncryptedWorkspace: false,
    retentionUntil: null,
  },
  model: { model: "deepseek/deepseek-chat", base_url: "https://openrouter.ai/api/v1", temperature: 0 as const, provider_order: ["approved-provider"], allow_fallbacks: false as const, data_collection: "deny" as const },
  documents: ["baseline", "candidate"].map((document_id) => ({ document_id, display_name: `${document_id}.txt`, format: "text", language: "en", raw_artifact_path: `sources/raw/${document_id}.txt`, normalized_artifact_path: `sources/normalized/${document_id}.json`, sha256: "0".repeat(64), page_count: 1, record_count: 1, canonicalization_version: "canon-v1" as const })),
  normalization_version: "canon-v1" as const,
};

describe("workspace ledger", () => {
  it("keeps an event-chain-backed state projection", async () => {
    const parent = await mkdtemp(join(tmpdir(), "leap-workspace-test-"));
    temporaryPaths.push(parent);
    const workspace = await createWorkspace(join(parent, "run"), workspaceManifest);
    await transitionState(workspace, "ingesting");
    await transitionState(workspace, "normalized");
    await expect(validateLedger(workspace)).resolves.toMatchObject({ state: "normalized", last_event_sequence: 3 });
  });

  it("serializes concurrent event writers without gaps", async () => {
    const parent = await mkdtemp(join(tmpdir(), "leap-workspace-test-"));
    temporaryPaths.push(parent);
    const workspace = await createWorkspace(join(parent, "run"), workspaceManifest);
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendEvent(workspace, "artifact_created", "coordinator", { artifact: `artifact-${index}` })));
    await expect(validateLedger(workspace)).resolves.toMatchObject({ last_event_sequence: 13 });
  });

  it("records exactly one immutable reservation for each permitted model call", async () => {
    const parent = await mkdtemp(join(tmpdir(), "leap-workspace-test-"));
    temporaryPaths.push(parent);
    const workspace = await createWorkspace(join(parent, "run"), workspaceManifest);
    await expect(Promise.all([
      reserveModelCall(workspace, "mapper", null),
      reserveModelCall(workspace, "theme_worker", "thm-001-cdd"),
      reserveModelCall(workspace, "theme_worker", "thm-001-cdd"),
    ])).resolves.toEqual([true, true, false]);
    await expect(validateLedger(workspace)).resolves.toMatchObject({ used_agent_calls: 2, remaining_agent_calls: 0, last_event_sequence: 3 });
  });
});
