import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isMissing } from "../persistence/storage.js";

const SKIP = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor", ".git"]);
/** Bounds on the index: the composer needs candidates, not a complete file listing. */
export const MAX_INDEXED = 20_000;
export const MAX_DEPTH = 12;

/**
 * Repository-relative file paths for `@` completion. Symlinked directories are not followed,
 * dot-directories and build output are skipped, and the walk is bounded in both size and depth.
 */
export async function indexFiles(root: string, limit = MAX_INDEXED): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (paths.length >= limit || depth > MAX_DEPTH) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const entry of entries) {
      if (paths.length >= limit) return;
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) paths.push(relative(root, full).split(sep).join("/"));
    }
  };
  await walk(root, 0);
  return paths;
}

/** Subsequence score: contiguous runs, basename hits, and early matches rank higher. */
function score(path: string, query: string): number {
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  let position = 0;
  let points = 0;
  let previous = -2;
  const base = haystack.lastIndexOf("/") + 1;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found < 0) return -1;
    points += found === previous + 1 ? 6 : 1;
    if (found >= base) points += 3;
    if (found === base) points += 4;
    previous = found;
    position = found + 1;
  }
  return points - Math.floor(haystack.length / 40);
}

export function matchFiles(paths: string[], query: string, limit = 8): string[] {
  if (!query) return paths.slice(0, limit);
  return paths
    .map((path) => ({ path, points: score(path, query) }))
    .filter(({ points }) => points >= 0)
    .sort((a, b) => b.points - a.points || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ path }) => path);
}
