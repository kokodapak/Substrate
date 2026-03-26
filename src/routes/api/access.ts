import { Router, Request, Response } from 'express';
import { db, sqlite } from '../../db/index';
import { accessRules, graphSnapshots } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { parseBotignoreContent, parseBotincludeContent, ParsedRule } from '../../services/botignore-parser';
import { evaluateAccess, AccessDomain } from '../../services/access-evaluator';
import { randomUUID } from 'crypto';

const router = Router();

// ─── GET /api/access ──────────────────────────────────────────────────────────
router.get('/', requireAdmin, (_req: Request, res: Response): void => {
  const all = db.select().from(accessRules).all();

  const botignoreRules = all
    .filter((r) => r.source === 'botignore')
    .map((r) => ({ pattern: r.pattern, domain: r.domain, action: 'deny' as const }));

  const botincludeRules = all
    .filter((r) => r.source === 'botinclude')
    .map((r) => ({ pattern: r.pattern, domain: r.domain, action: 'allow' as const }));

  // Build summary — rules with domain='any' count toward all domain summary counts
  const summaryDomains = ['file', 'service', 'env'] as const;
  const summary: Record<string, { denied: number; allowed: number }> = {};

  for (const d of summaryDomains) {
    summary[d] = { denied: 0, allowed: 0 };
  }

  for (const rule of all) {
    const applies = rule.domain === 'any' ? summaryDomains : ([rule.domain].filter((d): d is typeof summaryDomains[number] => summaryDomains.includes(d as typeof summaryDomains[number])));
    for (const d of applies) {
      if (rule.action === 'deny') {
        summary[d].denied++;
      } else {
        summary[d].allowed++;
      }
    }
  }

  res.status(200).json({
    botignore_rules: botignoreRules,
    botinclude_rules: botincludeRules,
    summary,
  });
});

// ─── Helper: count blocked/allowed nodes from latest snapshot ─────────────────
interface GraphNode {
  type?: string;
  name?: string;
  path?: string;
  domain?: string;
}

function getLatestGraphNodes(): GraphNode[] {
  const snapshot = db
    .select()
    .from(graphSnapshots)
    .orderBy(desc(graphSnapshots.version))
    .limit(1)
    .all()[0];

  if (!snapshot) return [];

  try {
    const data = JSON.parse(snapshot.graphData) as unknown;
    if (!data || typeof data !== 'object') return [];
    const d = data as Record<string, unknown>;

    // Support both { nodes: [...] } and { services: [...], files: [...] } shapes
    if (Array.isArray(d['nodes'])) {
      return d['nodes'] as GraphNode[];
    }

    const nodes: GraphNode[] = [];
    if (Array.isArray(d['services'])) {
      for (const s of d['services'] as GraphNode[]) {
        nodes.push({ ...s, domain: 'service' });
      }
    }
    if (Array.isArray(d['files'])) {
      for (const f of d['files'] as GraphNode[]) {
        nodes.push({ ...f, domain: 'file' });
      }
    }
    return nodes;
  } catch {
    return [];
  }
}

function countDeniedNodes(): number {
  const nodes = getLatestGraphNodes();
  let denied = 0;
  for (const node of nodes) {
    const domain: AccessDomain = (node.domain === 'service' || node.domain === 'file' || node.domain === 'env' || node.domain === 'integration') ? node.domain : 'any';
    const target = node.name ?? node.path ?? '';
    if (!target) continue;
    const result = evaluateAccess(target, domain);
    if (result.result === 'deny') denied++;
  }
  return denied;
}

function countAllowedNodes(): number {
  const nodes = getLatestGraphNodes();
  let allowed = 0;
  for (const node of nodes) {
    const domain: AccessDomain = (node.domain === 'service' || node.domain === 'file' || node.domain === 'env' || node.domain === 'integration') ? node.domain : 'any';
    const target = node.name ?? node.path ?? '';
    if (!target) continue;
    const result = evaluateAccess(target, domain);
    if (result.result === 'allow') allowed++;
  }
  return allowed;
}

// ─── Helper: replace all rules for a source in a single transaction ───────────
function replaceRules(source: 'botignore' | 'botinclude', rules: ParsedRule[]): void {
  // Use the raw better-sqlite3 transaction API (synchronous, atomic)
  const txn = sqlite.transaction(() => {
    // Delete all existing rules for this source
    db.delete(accessRules).where(eq(accessRules.source, source)).run();

    // Insert new rules — UNIQUE(source, pattern, domain) so onConflictDoNothing is safe
    for (const rule of rules) {
      db
        .insert(accessRules)
        .values({
          id: randomUUID(),
          source,
          pattern: rule.pattern,
          domain: rule.domain,
          action: rule.action,
        })
        .onConflictDoNothing()
        .run();
    }
  });

  txn();
}

// ─── PUT /api/access/botignore ────────────────────────────────────────────────
router.put('/botignore', requireAdmin, (req: Request, res: Response): void => {
  const { content } = req.body as { content?: unknown };

  if (typeof content !== 'string') {
    res.status(400).json({ error: 'invalid_params', detail: 'body must have a "content" string field' });
    return;
  }

  let rules: ParsedRule[];
  try {
    rules = parseBotignoreContent(content);
  } catch (err: unknown) {
    const e = err as { code?: string; detail?: string };
    res.status(400).json({ error: 'parse_error', detail: e.detail ?? 'Parse failed' });
    return;
  }

  replaceRules('botignore', rules);

  const blocked_nodes = countDeniedNodes();
  res.status(200).json({ parsed_rules: rules.length, blocked_nodes });
});

// ─── PUT /api/access/botinclude ───────────────────────────────────────────────
router.put('/botinclude', requireAdmin, (req: Request, res: Response): void => {
  const { content } = req.body as { content?: unknown };

  if (typeof content !== 'string') {
    res.status(400).json({ error: 'invalid_params', detail: 'body must have a "content" string field' });
    return;
  }

  let rules: ParsedRule[];
  try {
    rules = parseBotincludeContent(content);
  } catch (err: unknown) {
    const e = err as { code?: string; detail?: string };
    res.status(400).json({ error: 'parse_error', detail: e.detail ?? 'Parse failed' });
    return;
  }

  replaceRules('botinclude', rules);

  const allowed_nodes = countAllowedNodes();
  res.status(200).json({ parsed_rules: rules.length, allowed_nodes });
});

// ─── GET /api/access/preview ──────────────────────────────────────────────────
const VALID_DOMAINS: AccessDomain[] = ['file', 'service', 'env', 'integration', 'any'];

router.get('/preview', requireAdmin, (req: Request, res: Response): void => {
  const { target, domain } = req.query as { target?: string; domain?: string };

  if (!target || typeof target !== 'string') {
    res.status(400).json({ error: 'invalid_params', detail: '"target" query param is required' });
    return;
  }

  if (!domain || !VALID_DOMAINS.includes(domain as AccessDomain)) {
    res.status(400).json({
      error: 'invalid_params',
      detail: `"domain" query param must be one of: ${VALID_DOMAINS.join(', ')}`,
    });
    return;
  }

  const evalResult = evaluateAccess(target, domain as AccessDomain);

  res.status(200).json({
    result: evalResult.result,
    matched_rule: evalResult.matchedRule,
    matched_source: evalResult.matchedSource,
  });
});

export default router;
