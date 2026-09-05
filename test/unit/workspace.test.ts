import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, createWorkspace, transitionState, validateLedger } from "../../src/workspace.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace ledger", () => {
  it("keeps an event-chain-backed state projection", async () => {
    const parent = await mkdtemp(join(tmpdir(), "leap-workspace-test-"));
    temporaryPaths.push(parent);
    const workspace = await createWorkspace(join(parent, "run"), {
      profile: "version-change",
      data_classification: "public",
      options: {
        profile: "version-change",
        dataClassification: "public",
        maxThemes: 1,
        concurrency: 1,
        agentCallBudget: 2,
        agentTimeoutSeconds: 30,
        maxSourcePages: 1,
        maxSourceChars: 10_000,
        allowPartial: false,
        autoApprove: true,
        confirmExternalAgentAccess: false,
        confirmEncryptedWorkspace: false,
        retentionUntil: null,
      },
      documents: [],
      normalization_version: "canon-v1",
    });
    await transitionState(workspace, "ingesting");
    await transitionState(workspace, "normalized");
    await expect(validateLedger(workspace)).resolves.toMatchObject({ state: "normalized", last_event_sequence: 3 });
  });

  it("serializes concurrent event writers without gaps", async () => {
    const parent = await mkdtemp(join(tmpdir(), "leap-workspace-test-"));
    temporaryPaths.push(parent);
    const workspace = await createWorkspace(join(parent, "run"), {
      profile: "version-change", data_classification: "public",
      options: { profile: "version-change", dataClassification: "public", maxThemes: 1, concurrency: 1, agentCallBudget: 2, agentTimeoutSeconds: 30, maxSourcePages: 1, maxSourceChars: 10_000, allowPartial: false, autoApprove: true, confirmExternalAgentAccess: false, confirmEncryptedWorkspace: false, retentionUntil: null },
      documents: [], normalization_version: "canon-v1",
    });
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendEvent(workspace, "artifact_created", "coordinator", { artifact: `artifact-${index}` })));
    await expect(validateLedger(workspace)).resolves.toMatchObject({ last_event_sequence: 13 });
  });
});
