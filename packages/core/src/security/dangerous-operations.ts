export type OperationSeverity = "safe" | "caution" | "dangerous";

export interface OperationRisk {
  /** Short slug for the rule that matched, e.g. "drop_table". */
  rule: string;
  severity: OperationSeverity;
  /** What the rule saw, in plain words. */
  reason: string;
}

export interface OperationAssessment {
  operation: string;
  severity: OperationSeverity;
  requiresConfirmation: boolean;
  risks: OperationRisk[];
  /** Set when the operation appears to target production. */
  productionTarget: boolean;
}

interface Rule {
  rule: string;
  severity: OperationSeverity;
  reason: string;
  pattern: RegExp;
  /** A rule that only matters when it is *not* narrowed by something else. */
  unless?: RegExp;
}

/**
 * Operations that must not run without an explicit confirmation (PRD 38).
 * Deliberately conservative and deterministic: a missed match costs a warning,
 * a false positive costs the developer's trust in every warning after it.
 */
const RULES: Rule[] = [
  {
    rule: "drop_database",
    severity: "dangerous",
    reason: "drops a database",
    pattern: /\bdrop\s+(database|schema)\b/i,
  },
  {
    rule: "drop_table",
    severity: "dangerous",
    reason: "drops a table",
    pattern: /\bdrop\s+table\b/i,
  },
  {
    rule: "truncate",
    severity: "dangerous",
    reason: "truncates a table",
    pattern: /\btruncate\s+(table\s+)?\w+/i,
  },
  {
    rule: "unfiltered_delete",
    severity: "dangerous",
    reason: "deletes every row (no WHERE clause)",
    pattern: /\bdelete\s+from\s+[\w."`[\]]+\s*(;|$)/i,
  },
  {
    rule: "unfiltered_update",
    severity: "dangerous",
    reason: "updates every row (no WHERE clause)",
    pattern: /\bupdate\s+[\w."`[\]]+\s+set\b(?![\s\S]*\bwhere\b)/i,
  },
  {
    rule: "recursive_delete",
    severity: "dangerous",
    reason: "recursively deletes files",
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force/i,
  },
  {
    rule: "wildcard_delete",
    severity: "dangerous",
    reason: "deletes files by wildcard",
    pattern: /\b(rm|del|erase)\s+[^\n]*[*?][^\n]*/i,
  },
  {
    rule: "force_push",
    severity: "dangerous",
    reason: "force-pushes, rewriting published history",
    pattern: /\bgit\s+push\b[^\n]*(--force\b(?!-with-lease)|\s-f\b)/i,
  },
  {
    rule: "history_rewrite",
    severity: "dangerous",
    reason: "discards local work or rewrites history",
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|filter-branch|checkout\s+--\s)/i,
  },
  {
    rule: "migration",
    severity: "caution",
    reason: "runs a database migration",
    pattern: /\b(migrate|migration)\b[^\n]*\b(up|deploy|run|apply|reset|down)\b|\b(prisma|knex|alembic|sequelize|typeorm|rails)\b[^\n]*\bmigrat/i,
  },
  {
    rule: "deployment",
    severity: "caution",
    reason: "deploys",
    pattern: /\b(deploy|release|publish)\b|\b(vercel|netlify|fly|heroku|kubectl\s+apply|terraform\s+apply|serverless)\b/i,
  },
  {
    rule: "credential_write",
    severity: "caution",
    reason: "writes to a credentials or environment file",
    pattern: /[>|]\s*[^\n]*\.env\b|\bwrite[^\n]*\.env\b|\b(chmod|icacls)\b[^\n]*\.(pem|key)\b/i,
  },
  {
    rule: "package_publish",
    severity: "caution",
    reason: "publishes a package",
    pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
  },
];

const PRODUCTION = /\b(prod|production|live)\b|--env[= ](prod|production)|NODE_ENV=production/i;

/**
 * Classifies a shell command, SQL statement or described action. DevMemory does not
 * execute anything itself - this exists so an agent can ask before it does (PRD 38).
 */
export function assessOperation(operation: string): OperationAssessment {
  const text = operation.trim();
  const risks: OperationRisk[] = [];

  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.unless?.test(text)) continue;
    risks.push({ rule: rule.rule, severity: rule.severity, reason: rule.reason });
  }

  const productionTarget = PRODUCTION.test(text);
  let severity: OperationSeverity = "safe";
  if (risks.some((risk) => risk.severity === "dangerous")) severity = "dangerous";
  else if (risks.length > 0) severity = "caution";

  // Anything aimed at production is escalated: a migration on a laptop and the same
  // migration on production are not the same operation.
  if (productionTarget && severity === "caution") severity = "dangerous";

  return {
    operation: text,
    severity,
    requiresConfirmation: severity === "dangerous",
    risks,
    productionTarget,
  };
}

export function isDangerous(operation: string): boolean {
  return assessOperation(operation).severity === "dangerous";
}
