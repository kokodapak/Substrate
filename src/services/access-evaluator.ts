import ignore from 'ignore';
import { db } from '../db/index';
import { accessRules } from '../db/schema';
import { eq, or } from 'drizzle-orm';

export type AccessDomain = 'file' | 'service' | 'env' | 'integration' | 'any';

export interface AccessEvalResult {
  result: 'allow' | 'deny';
  matchedRule: string | null;
  matchedSource: 'botignore' | 'botinclude' | 'auto_deny' | 'default_deny' | null;
}

const AUTO_DENY_KEYWORDS = ['SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'CREDENTIAL'];

/**
 * Evaluates whether a target is allowed or denied by current access rules.
 *
 * Precedence (highest to lowest):
 * 1. auto_deny_sensitive_pattern — env key names containing sensitive keywords
 * 2. botignore deny rules
 * 3. botinclude allow rules
 * 4. default_deny
 */
export function evaluateAccess(target: string, domain: AccessDomain): AccessEvalResult {
  // 1. Auto-deny sensitive env key names
  if (domain === 'env') {
    const upper = target.toUpperCase();
    for (const keyword of AUTO_DENY_KEYWORDS) {
      if (upper.includes(keyword)) {
        return { result: 'deny', matchedRule: 'sensitive-pattern', matchedSource: 'auto_deny' };
      }
    }
  }

  // Read access rules from DB (better-sqlite3 is synchronous).
  // Fetch rules that apply to this specific domain OR to 'any'.
  const allRules = db
    .select()
    .from(accessRules)
    .where(or(eq(accessRules.domain, domain), eq(accessRules.domain, 'any')))
    .all();

  const denyRules = allRules.filter((r) => r.source === 'botignore' && r.action === 'deny');
  const allowRules = allRules.filter((r) => r.source === 'botinclude' && r.action === 'allow');

  // Helper: check if a single pattern matches target using the ignore package.
  // The `ignore` package requires relative paths (no leading '/').
  // We normalize both pattern and target by stripping the leading '/' so that
  // gitignore semantics are preserved (absolute-style patterns like /etc/passwd
  // still match the same absolute-style targets).
  function matchesPattern(pattern: string, t: string): boolean {
    const normalizedPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    const normalizedTarget = t.startsWith('/') ? t.slice(1) : t;
    // Skip empty normalized targets (shouldn't happen in practice)
    if (!normalizedTarget) return false;
    const ig = ignore();
    ig.add(normalizedPattern);
    return ig.ignores(normalizedTarget);
  }

  // 2. Check botignore deny rules
  const matchedDenyRule = denyRules.find((r) => matchesPattern(r.pattern, target));
  if (matchedDenyRule) {
    return {
      result: 'deny',
      matchedRule: matchedDenyRule.pattern,
      matchedSource: 'botignore',
    };
  }

  // 3. Check botinclude allow rules
  const matchedAllowRule = allowRules.find((r) => matchesPattern(r.pattern, target));
  if (matchedAllowRule) {
    return {
      result: 'allow',
      matchedRule: matchedAllowRule.pattern,
      matchedSource: 'botinclude',
    };
  }

  // 4. Default deny
  return { result: 'deny', matchedRule: null, matchedSource: 'default_deny' };
}
