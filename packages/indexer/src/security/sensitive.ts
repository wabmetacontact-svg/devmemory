import path from "node:path";

/**
 * Files that must never be indexed, cached or returned as context (PRD 20, 37).
 * This list is enforced independently of user ignore rules, so relaxing the
 * indexing config can never expose a private key.
 */
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".htpasswd",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "master.key",
  "service-account.json",
  "serviceaccount.json",
]);

const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^credentials(\..+)?$/i,
  /^secrets?(\..+)?$/i,
  /(^|[.\-_])secrets?\.(json|ya?ml|toml|ini|txt)$/i,
  /\.(pem|key|pfx|p12|jks|keystore|asc|gpg|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /\.kdbx$/i,
];

const SENSITIVE_DIRECTORIES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);

export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (SENSITIVE_BASENAMES.has(base.toLowerCase())) return true;
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(base))) return true;
  return normalized
    .split("/")
    .slice(0, -1)
    .some((segment) => SENSITIVE_DIRECTORIES.has(segment.toLowerCase()));
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Detectors for credentials embedded in otherwise ordinary source files.
 * Deliberately conservative: a missed match is a cosmetic loss, a false positive
 * on real code is a correctness loss for the agent reading the context.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "aws_access_key_id", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe_key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "openai_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "private_key_block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "assigned_secret", pattern: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'#,;]{8,})["']?/g },
];

export interface RedactionResult {
  text: string;
  redactions: Array<{ name: string; count: number }>;
}

export const REDACTED = "<REDACTED>";

/** Replaces detected credentials with <REDACTED> (PRD 37). */
export function redactSecrets(text: string): RedactionResult {
  let output = text;
  const redactions: Array<{ name: string; count: number }> = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    let count = 0;
    const regex = new RegExp(pattern.source, pattern.flags);
    output = output.replace(regex, (match, ...groups) => {
      count++;
      if (name === "assigned_secret") {
        const key = groups[0] as string;
        return `${key}=${REDACTED}`;
      }
      return REDACTED;
    });
    if (count > 0) redactions.push({ name, count });
  }

  return { text: output, redactions };
}

export interface SecretFinding {
  name: string;
  count: number;
}

/** Which credential detectors fired, and how often - without building a redacted copy. */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    if (matches && matches.length > 0) findings.push({ name, count: matches.length });
  }
  return findings;
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text));
}
