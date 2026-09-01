/**
 * Deterministic token estimate (PRD 24, 65). No tokenizer dependency: DevMemory
 * only needs a stable budgeting signal, not exact provider accounting.
 * ~4 characters per token for source code is the common approximation.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function estimateTokensForBytes(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.max(1, Math.ceil(bytes / CHARS_PER_TOKEN));
}
