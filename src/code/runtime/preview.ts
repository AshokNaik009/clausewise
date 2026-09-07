import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ApprovalRequest } from "./approvals.js";
import { isMissing } from "../persistence/storage.js";

export async function previewAction(cwd: string, action: ApprovalRequest["value"]["actionRequests"][number], routes: string[]): Promise<string> {
  if (!["write_file", "edit_file"].includes(action.name)) return JSON.stringify(action.args, null, 2);
  const path = action.args.file_path;
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0")) throw new Error("Invalid file path for preview");
  const segments = path.replace(/^\//u, "").split("/");
  if (segments.some((segment) => !segment || segment === ".." || segment === ".")) throw new Error("Preview path must be repository-relative");
  if (routes.some((route) => `/${segments.join("/")}`.startsWith(route))) return `Virtual backend route; review arguments instead of a host-file diff:\n${JSON.stringify(action.args, null, 2)}`;
  const root = await realpath(cwd);
  const target = join(root, ...segments);
  for (let index = 1; index <= segments.length; index++) {
    try { if ((await lstat(join(root, ...segments.slice(0, index)))).isSymbolicLink()) throw new Error("Symlink paths are not read by the approval preview"); }
    catch (error) { if (!isMissing(error)) throw error; break; }
  }
  let before = "";
  let exists = false;
  try {
    const resolved = await realpath(target);
    const within = relative(root, resolved);
    if (within.startsWith("..") || isAbsolute(within)) throw new Error("Preview path escapes the repository");
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256_000) throw new Error("Preview supports regular text files up to 256 KB");
      before = await file.readFile("utf8");
      if (before.includes("\0")) throw new Error("Binary file previews are not supported");
      exists = true;
    } finally { await file.close(); }
  } catch (error) { if (!isMissing(error)) throw error; }
  let after: string;
  if (action.name === "write_file") {
    if (exists) throw new Error("write_file targets an existing file; the SDK requires edit_file instead");
    if (typeof action.args.content !== "string") throw new Error("write_file requires text content");
    after = action.args.content;
  } else {
    if (!exists) throw new Error("The file to edit does not exist");
    const old = action.args.old_string;
    const replacement = action.args.new_string;
    if (typeof old !== "string" || !old || typeof replacement !== "string") throw new Error("Invalid replacement arguments");
    const parts = before.split(old);
    if (parts.length === 1 || (parts.length > 2 && action.args.replace_all !== true)) throw new Error("Replacement is missing or ambiguous in the current file");
    after = action.args.replace_all === true ? parts.join(replacement) : before.replace(old, () => replacement);
  }
  if (Buffer.byteLength(after) > 256_000) throw new Error("Proposed file exceeds the 256 KB preview limit");
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < Math.min(oldLines.length, newLines.length) && oldLines[start] === newLines[start]) start++;
  if (start === oldLines.length && start === newLines.length) return "No content changes proposed.";
  let end = 0;
  while (end < Math.min(oldLines.length, newLines.length) - start && oldLines.at(-end - 1) === newLines.at(-end - 1)) end++;
  const contextStart = Math.max(0, start - 3);
  const contextEnd = Math.min(3, end);
  const lines = [
    `--- ${exists ? path : "/dev/null"}`, `+++ ${path}`,
    `@@ -${contextStart + 1},${oldLines.length - end + contextEnd - contextStart} +${contextStart + 1},${newLines.length - end + contextEnd - contextStart} @@`,
    ...oldLines.slice(contextStart, start).map((line) => `  ${line}`),
    ...oldLines.slice(start, oldLines.length - end).map((line) => `- ${line}`),
    ...newLines.slice(start, newLines.length - end).map((line) => `+ ${line}`),
    ...oldLines.slice(oldLines.length - end, oldLines.length - end + contextEnd).map((line) => `  ${line}`),
  ];
  return `Current-file preview only; the file may change before execution.\n${lines.join("\n")}`;
}
