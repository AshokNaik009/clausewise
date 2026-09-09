/**
 * Unified-diff formatting shared by the approval preview and the transcript, so both show
 * a change the same way. Lines are prefixed `  `, `- `, `+ ` and are safe to colour by prefix.
 */
export function unifiedDiff(path: string, before: string, after: string, options: { exists?: boolean; context?: number } = {}): string[] | null {
  const context = options.context ?? 3;
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < Math.min(oldLines.length, newLines.length) && oldLines[start] === newLines[start]) start++;
  if (start === oldLines.length && start === newLines.length) return null;
  let end = 0;
  while (end < Math.min(oldLines.length, newLines.length) - start && oldLines.at(-end - 1) === newLines.at(-end - 1)) end++;
  const contextStart = Math.max(0, start - context);
  const contextEnd = Math.min(context, end);
  return [
    `--- ${options.exists === false ? "/dev/null" : path}`, `+++ ${path}`,
    `@@ -${contextStart + 1},${oldLines.length - end + contextEnd - contextStart} +${contextStart + 1},${newLines.length - end + contextEnd - contextStart} @@`,
    ...oldLines.slice(contextStart, start).map((line) => `  ${line}`),
    ...oldLines.slice(start, oldLines.length - end).map((line) => `- ${line}`),
    ...newLines.slice(start, newLines.length - end).map((line) => `+ ${line}`),
    ...oldLines.slice(oldLines.length - end, oldLines.length - end + contextEnd).map((line) => `  ${line}`),
  ];
}

/**
 * Diff of a proposed `edit_file` replacement on its own. The surrounding file is not read here,
 * so this shows the replacement rather than the resulting file.
 */
export function replacementDiff(path: string, oldString: string, newString: string): string[] {
  return [
    `--- ${path}`, `+++ ${path}`,
    ...oldString.split("\n").map((line) => `- ${line}`),
    ...newString.split("\n").map((line) => `+ ${line}`),
  ];
}

/** Added/removed line counts for a one-line summary above a collapsed diff. */
export function diffStat(lines: string[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.startsWith("+ ")).length,
    removed: lines.filter((line) => line.startsWith("- ")).length,
  };
}
