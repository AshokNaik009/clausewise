import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isMissing } from "../persistence/storage.js";

/** HEAD is tiny; anything larger is not a git HEAD and is ignored rather than parsed. */
const MAX_HEAD_BYTES = 4096;

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_HEAD_BYTES) return undefined;
      return await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function gitDirectory(cwd: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const candidate = join(directory, ".git");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/mu.exec((await readSmall(candidate)) ?? "")?.[1]?.trim();
        if (pointer) return isAbsolute(pointer) ? pointer : resolve(directory, pointer);
      }
    } catch (error) { if (!isMissing(error)) throw error; }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

const cache = new Map<string, { at: number; branch?: string }>();
/** How long a branch reading is reused. Long enough to keep the render path off the disk. */
export const BRANCH_TTL_MS = 5000;

/**
 * Current branch (or short detached-HEAD sha) read straight from `.git/HEAD`. No subprocess:
 * this is called from the render path, where spawning git would stall the UI.
 */
export async function gitBranch(cwd: string, now: number = Date.now()): Promise<string | undefined> {
  const cached = cache.get(cwd);
  if (cached && now - cached.at < BRANCH_TTL_MS) return cached.branch;
  let branch: string | undefined;
  const directory = await gitDirectory(cwd);
  if (directory) {
    const head = (await readSmall(join(directory, "HEAD")))?.trim() ?? "";
    const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head)?.[1];
    branch = ref ?? (/^[0-9a-f]{7,64}$/u.test(head) ? head.slice(0, 7) : undefined);
  }
  cache.set(cwd, { at: now, ...(branch ? { branch } : {}) });
  return branch;
}
