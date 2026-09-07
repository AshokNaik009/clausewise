import { constants } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isMissing } from "./storage.js";

const ownerSchema = z.object({ pid: z.number().int().positive(), host: z.string().optional(), token: z.string().uuid().optional() });

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}

async function release(path: string, handle: FileHandle): Promise<void> {
  try {
    const held = await handle.stat();
    const current = await lstat(path).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
    if (current?.ino === held.ino && current.dev === held.dev) await unlink(path);
  } finally { await handle.close(); }
}

export async function acquireSessionLock(path: string): Promise<() => Promise<void>> {
  if (await exists(`${path}.recovery`)) throw new Error("Session lock recovery is in progress");
  const handle = await open(path, "wx", 0o600).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Session is in use; use recover-lock after its owning process has stopped");
    throw error;
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }));
    await handle.sync();
    if (await exists(`${path}.recovery`)) throw new Error("Session lock recovery is in progress");
    return () => release(path, handle);
  } catch (error) { await release(path, handle); throw error; }
}

export async function recoverSessionLock(path: string): Promise<{ archive: string; pid: number }> {
  const guardPath = `${path}.recovery`;
  const guard = await open(guardPath, "wx", 0o600);
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    await guard.sync();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      if (!held.isFile() || held.size > 4096) throw new Error("Invalid session lock; preserve it for manual inspection");
      const owner = ownerSchema.parse(JSON.parse(await handle.readFile("utf8")));
      if (owner.host && owner.host !== hostname()) throw new Error("Cannot recover a lock owned by another host");
      try { process.kill(owner.pid, 0); throw new Error("Lock owner is still alive; recovery refused"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      const current = await lstat(path);
      if (current.ino !== held.ino || current.dev !== held.dev) throw new Error("Lock changed during recovery; retry after inspection");
      const archive = `${path}.recovered-${randomUUID()}`;
      await rename(path, archive);
      return { archive, pid: owner.pid };
    } finally { await handle.close(); }
  } finally { await release(guardPath, guard); }
}
