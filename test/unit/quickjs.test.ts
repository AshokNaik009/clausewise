import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeQuickJs } from "../../src/quickjs.js";
import { createWorkspace } from "../../src/workspace.js";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const parent = await mkdtemp(join(tmpdir(), "leap-quickjs-test-"));
  temporaryPaths.push(parent);
  return createWorkspace(join(parent, "run"), {
    profile: "cross-guidance",
    data_classification: "public",
    options: {
      profile: "cross-guidance", dataClassification: "public", maxThemes: 1, concurrency: 1, agentCallBudget: 2, agentTimeoutSeconds: 30, maxSourcePages: 1, maxSourceChars: 10_000,
      allowPartial: false, autoApprove: true, confirmExternalModelAccess: false, confirmEncryptedWorkspace: false, retentionUntil: null,
    },
    model: { model: "deepseek/deepseek-chat", base_url: "https://openrouter.ai/api/v1", temperature: 0, provider_order: ["approved-provider"], allow_fallbacks: false, data_collection: "deny" },
    documents: ["baseline", "candidate"].map((document_id) => ({ document_id, display_name: `${document_id}.txt`, format: "text", language: "en", raw_artifact_path: `sources/raw/${document_id}.txt`, normalized_artifact_path: `sources/normalized/${document_id}.json`, sha256: "0".repeat(64), page_count: 1, record_count: 1, canonicalization_version: "canon-v1" })),
    normalization_version: "canon-v1",
  });
}

describe("QuickJS capability bridge", () => {
  it("exposes only declared artifact data and records the execution", async () => {
    const run = await workspace();
    const execution = await executeQuickJs(run, {
      capability: "capability", caller_role: "theme_worker", script: "JSON.parse(readArtifact('input/packet.json')).answer", requested_reads: ["input/packet.json"], requested_writes: [],
    }, {
      capability: "capability", callerRole: "theme_worker", themeId: "thm-001-cdd", allowedReads: { "input/packet.json": "{\"answer\":42}" }, allowedWrites: ["result.json"],
    });
    expect(execution.result).toBe(42);
    expect(execution.resource_outcome).toBe("ok");
    expect(execution.allowed_reads).toEqual(["input/packet.json"]);
  });

  it("rejects requests for unapproved reads before execution", async () => {
    const run = await workspace();
    await expect(executeQuickJs(run, {
      capability: "capability", caller_role: "theme_worker", script: "1", requested_reads: ["sources/normalized/baseline.json"], requested_writes: [],
    }, {
      capability: "capability", callerRole: "theme_worker", themeId: "thm-001-cdd", allowedReads: {}, allowedWrites: [],
    })).rejects.toMatchObject({ code: "quickjs_read_denied" });
  });
});
