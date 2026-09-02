/** What the developer is trying to do, inferred from the request text (PRD 21). */
export type Intent = "debug" | "implement" | "test" | "refactor" | "explain" | "review" | "general";

export interface ParsedRequest {
  raw: string;
  intent: Intent;
  /** Meaningful search terms, stopwords removed. */
  terms: string[];
  /** Tokens that look like code identifiers rather than prose. */
  symbolCandidates: string[];
  /** Tokens that look like file paths. */
  pathCandidates: string[];
  /** The most informative line of a pasted stack trace, if there is one. */
  errorSignature: string | null;
}

const INTENT_PATTERNS: Array<{ intent: Intent; pattern: RegExp; weight: number }> = [
  // \w*(error|exception) so TypeError, ValueError and friends count as debugging.
  { intent: "debug", pattern: /\b(fix(e[sd]|ing)?|bug|broken|fails?|failing|\w*(error|exception)|crash|stack ?trace|throws?|regression|debug|traceback|segfault)\b/i, weight: 3 },
  { intent: "test", pattern: /\b(tests?|testing|spec|coverage|vitest|jest|pytest|assert)\b/i, weight: 2 },
  { intent: "refactor", pattern: /\b(refactor|rename|extract|clean ?up|simplify|restructure|migrate|deduplicate)\b/i, weight: 2 },
  { intent: "review", pattern: /\b(review|audit|check|inspect|security|vulnerab)\w*\b/i, weight: 2 },
  { intent: "explain", pattern: /\b(how|why|what|where|explain|understand|works?|does)\b/i, weight: 1 },
  { intent: "implement", pattern: /\b(add|implement|create|build|support|introduce|write|wire|integrate|feature)\b/i, weight: 2 },
];

const STOPWORDS = new Set([
  "a", "about", "add", "all", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can",
  "code", "did", "do", "does", "doing", "for", "from", "get", "give", "has", "have", "how", "i", "if",
  "in", "into", "is", "it", "its", "just", "let", "like", "make", "me", "my", "need", "not", "now",
  "of", "on", "one", "only", "or", "our", "out", "over", "please", "should", "so", "some", "than",
  "that", "the", "their", "then", "there", "these", "they", "this", "to", "up", "us", "use", "want",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with",
  "would", "you", "your",
  // Hinglish filler, so a request written the way people actually type it does not
  // spend its search budget on "karna" and "hai".
  "aur", "ya", "hai", "hain", "tha", "the", "thi", "ho", "hona", "hoga", "karna", "karne", "karo", "kar", "kiya", "karta", "karte", "karti", "ek", "naya", "nayi", "naye", "me", "mein", "ka", "ki", "ke", "ko", "se", "par", "pe", "kya", "kaise", "kyun", "kyu", "chahiye", "wala", "wali", "wale", "do", "dena", "diya", "liye", "sakta", "sakte", "raha", "rahi", "rahe", "abhi", "phir", "bhi", "koi", "kuch", "sab", "bas", "toh", "to", "fir", "jo", "jab", "tab", "yaha", "waha", "yeh", "ye", "wo", "woh", "apna", "apne", "mera", "mere", "meri", "hamara", "tum", "aap",
]);

const PATH_LIKE = /[\w.@-]*[\\/][\w./\\@-]+|\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|json|yaml|yml|md|sql)\b/gi;
const CALL_LIKE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const PASCAL_OR_CAMEL = /\b([A-Z][a-z0-9]+[A-Za-z0-9]*|[a-z]+[A-Z][A-Za-z0-9]*|[a-z]+_[a-z0-9_]+)\b/g;
const BACKTICKED = /`([^`]{2,80})`/g;
const ERROR_LINE = /^.*(\b\w*(Error|Exception)\b|\bTraceback\b|\bPanic\b|\bFatal\b|\bassert\w*\b).*$/im;

/**
 * Deterministic request analysis (PRD 5.7): keyword scoring for intent, plus
 * extraction of the tokens that look like code rather than prose. No LLM involved -
 * this only has to be good enough to steer retrieval, and ranking corrects for it.
 */
export function parseRequest(task: string): ParsedRequest {
  const raw = task.trim();

  return {
    raw,
    intent: detectIntent(raw),
    terms: extractTerms(raw),
    symbolCandidates: extractSymbols(raw),
    pathCandidates: extractPaths(raw),
    errorSignature: extractErrorSignature(raw),
  };
}

export function detectIntent(task: string): Intent {
  const scores = new Map<Intent, number>();
  for (const { intent, pattern, weight } of INTENT_PATTERNS) {
    const matches = task.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
    if (matches) scores.set(intent, (scores.get(intent) ?? 0) + matches.length * weight);
  }

  let best: Intent = "general";
  let bestScore = 0;
  for (const [intent, score] of scores) {
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  }
  return best;
}

function extractTerms(task: string): string[] {
  const tokens = task.toLowerCase().match(/[a-z0-9_$]{2,}/g) ?? [];
  const terms: string[] = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token) || terms.includes(token)) continue;
    terms.push(token);
  }
  return terms.slice(0, 24);
}

function extractSymbols(task: string): string[] {
  const found = new Set<string>();

  for (const match of task.matchAll(BACKTICKED)) {
    const value = match[1]?.trim();
    if (value && /^[\w$.]+$/.test(value)) found.add(value.replace(/\(\)$/, ""));
  }
  for (const match of task.matchAll(CALL_LIKE)) {
    if (match[1] && !STOPWORDS.has(match[1].toLowerCase())) found.add(match[1]);
  }
  for (const match of task.matchAll(PASCAL_OR_CAMEL)) {
    const value = match[1];
    if (value && value.length >= 3 && !STOPWORDS.has(value.toLowerCase())) found.add(value);
  }

  return [...found].slice(0, 12);
}

function extractPaths(task: string): string[] {
  const found = new Set<string>();
  for (const match of task.matchAll(PATH_LIKE)) {
    const value = match[0].replace(/\\/g, "/").replace(/^["'`]|["'`.,;:]$/g, "");
    if (value.length >= 3) found.add(value);
  }
  return [...found].slice(0, 8);
}

function extractErrorSignature(task: string): string | null {
  const match = ERROR_LINE.exec(task);
  if (!match) return null;
  const line = match[0].trim();
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}
