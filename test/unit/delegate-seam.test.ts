import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemBackend } from "deepagents";
import { describe, expect, it } from "vitest";

// The delegate reads its packet through FilesystemBackend under the same options
// invokeSemanticDelegate uses. These bugs only ever appeared at this seam: the harness addressed
// a virtual path while the backend resolved real host paths, so nothing a pure-function test
// covered could catch it.
async function delegateScratch(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "reg-compare-seam-"));
  await mkdir(join(scratch, "input"), { recursive: true, mode: 0o700 });
  await writeFile(join(scratch, "input", "packet.json"), JSON.stringify({ kind: "mapper", records: [1, 2, 3] }), { mode: 0o600 });
  return scratch;
}

function delegateBackend(scratch: string): FilesystemBackend {
  return new FilesystemBackend({ rootDir: scratch, virtualMode: true });
}

type ReadResult = { content?: unknown; error?: unknown };
const read = async (backend: FilesystemBackend, path: string): Promise<ReadResult> =>
  await (backend as never as { read: (p: string) => Promise<ReadResult> }).read(path);

describe("delegate packet access", () => {
  it("reads the packet at the virtual path the delegate is told to use", async () => {
    const backend = delegateBackend(await delegateScratch());
    const result = await read(backend, "/input/packet.json");

    expect(result.error ?? null).toBeNull();
    expect(JSON.parse(String(result.content))).toMatchObject({ kind: "mapper" });
  });

  it("resolves the virtual root instead of the host root", async () => {
    // Regression: without virtualMode this ENOENTs against the real filesystem root, which is
    // what made every mapper attempt report "file not found".
    const legacy = new FilesystemBackend({ rootDir: await delegateScratch() });
    const result = await read(legacy, "/input/packet.json");
    expect(String(result.error ?? "")).toMatch(/ENOENT|no such file/iu);
  });

  it("refuses traversal out of the delegate sandbox", async () => {
    const backend = delegateBackend(await delegateScratch());
    for (const escape of ["/../../../etc/passwd", "/input/../../etc/passwd", "~/.ssh/id_rsa"]) {
      const result = await read(backend, escape);
      expect(String(result.error ?? ""), `${escape} must be refused`).toMatch(/traversal|not allowed|outside|ENOENT/iu);
      expect(String(result.content ?? "")).not.toMatch(/root:/u);
    }
  });
});
