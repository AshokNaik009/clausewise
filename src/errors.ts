export class RegCompareError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = "RegCompareError";
  }
}

export function assert(condition: unknown, code: string, message: string, exitCode?: number): asserts condition {
  if (!condition) throw new RegCompareError(code, message, exitCode);
}
