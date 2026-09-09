import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("State path must be a real directory, not a symlink");
}

export async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Invalid or oversized session file");
    const content = await handle.readFile("utf8");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new Error(`Invalid JSON in session file: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, `${JSON.stringify(value)}\n`);
}

export async function atomicText(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("Session checkpoint reached the 64 MiB limit. Start a new session; the last saved checkpoint is preserved.");
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}
