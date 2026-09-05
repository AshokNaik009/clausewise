import { AIMessage } from "@langchain/core/messages";
import { resolve } from "node:path";
import { fakeModel } from "@langchain/core/testing";
import { StateBackend, createDeepAgent, getHarnessProfile } from "deepagents";
import "../../src/shell.js";
import { describe, expect, it } from "vitest";

describe("shell filesystem isolation", () => {
  it("removes built-in filesystem and task tools from the shell model profile", () => {
    const profile = getHarnessProfile("openai:reg-compare-shell");
    expect([...profile?.excludedTools ?? []]).toEqual(expect.arrayContaining(["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep", "execute", "task"]));
    expect(profile?.generalPurposeSubagent).toMatchObject({ enabled: false });
  });

  it("denies every built-in filesystem read before the state backend is consulted", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "read_file", args: { file_path: resolve("test/fixtures/baseline.txt") } }])
      .respond(new AIMessage("Read attempt complete."));
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      permissions: [{ operations: ["read", "write"], paths: ["/**"], mode: "deny" }],
      systemPrompt: "Use only approved harness actions.",
    });

    const state = await agent.invoke({ messages: [{ role: "user", content: "Read the local fixture." }] });
    const messages = state.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    expect(messages.join("\n")).toContain("permission denied");
    expect(messages.join("\n")).not.toContain("CUSTOMER DUE DILIGENCE");
  });
});
