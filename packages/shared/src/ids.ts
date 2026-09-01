import crypto from "node:crypto";

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Deterministic project id derived from a stable identity string (PRD 9). */
export function projectIdFromIdentity(identity: string): string {
  return `proj_${sha256(identity).slice(0, 10)}`;
}

export function shortId(prefix: string, bytes = 5): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
