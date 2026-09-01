export type DevMemoryErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_CONNECTED"
  | "NOT_A_DIRECTORY"
  | "INVALID_INPUT"
  | "STORAGE_ERROR"
  | "GIT_ERROR"
  | "GIT_NOT_AVAILABLE"
  | "INDEX_ERROR"
  | "PERMISSION_DENIED"
  | "INTERNAL";

export class DevMemoryError extends Error {
  readonly code: DevMemoryErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DevMemoryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DevMemoryError";
    this.code = code;
    if (details) this.details = details;
  }

  toJSON(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export function isDevMemoryError(e: unknown): e is DevMemoryError {
  return e instanceof DevMemoryError;
}

export function toDevMemoryError(e: unknown, fallback: DevMemoryErrorCode = "INTERNAL"): DevMemoryError {
  if (isDevMemoryError(e)) return e;
  return new DevMemoryError(fallback, e instanceof Error ? e.message : String(e));
}
