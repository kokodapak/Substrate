import { Router } from 'express';
import * as vm from 'node:vm';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { sqlite } from '../../db/index';
import { rules } from '../../db/schema';

const router = Router();

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const KEBAB_CASE_RE = /^[a-z0-9-]+$/;

interface RuleBundle {
  id: string;
  name: string;
  description: string;
  severity: string;
  condition_source: string;
  recommended_action: string;
}

function validateRuleBundle(rule: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof rule !== 'object' || rule === null) {
    return { valid: false, errors: ['rule must be an object'] };
  }

  const r = rule as Record<string, unknown>;

  if (typeof r['id'] !== 'string' || !KEBAB_CASE_RE.test(r['id'])) {
    errors.push('id must match /^[a-z0-9-]+$/');
  }

  if (typeof r['name'] !== 'string' || r['name'].length === 0) {
    errors.push('name must be a non-empty string');
  }

  if (typeof r['description'] !== 'string' || r['description'].length === 0) {
    errors.push('description must be a non-empty string');
  }

  if (typeof r['severity'] !== 'string' || !VALID_SEVERITIES.has(r['severity'])) {
    errors.push('severity must be one of: critical, high, medium, low');
  }

  if (typeof r['condition_source'] !== 'string' || r['condition_source'].length === 0) {
    errors.push('condition_source must be a non-empty string');
  } else {
    try {
      new vm.Script('(function(graphData){' + r['condition_source'] + '})');
    } catch {
      errors.push('condition_source failed to compile: syntax error');
    }
  }

  if (typeof r['recommended_action'] !== 'string' || r['recommended_action'].length === 0) {
    errors.push('recommended_action must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

// POST /api/rules/registry/export
router.post('/rules/registry/export', requireAdmin, (_req, res) => {
  const rows = db.select().from(rules).where(eq(rules.builtIn, 0)).all();

  const result = rows.map((rule) => ({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    severity: rule.severity,
    condition_source: rule.conditionSource,
    recommended_action: rule.recommendedAction,
  }));

  return res.json({ rules: result });
});

// POST /api/rules/registry/import
router.post('/rules/registry/import', requireAdmin, (req, res) => {
  const body = req.body as Record<string, unknown>;

  if (typeof body !== 'object' || body === null || !Array.isArray(body['rules'])) {
    return res.status(400).json({ error: 'body must be an object with a rules array' });
  }

  const bundle = body['rules'] as unknown[];
  let imported = 0;
  let skipped = 0;
  const errors: { id: string; reason: string }[] = [];

  const insertStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (@id, @name, @description, @severity, @conditionSource, @recommendedAction, 0)
  `);

  for (const item of bundle) {
    const r = item as Record<string, unknown>;
    const ruleId = typeof r['id'] === 'string' ? r['id'] : '<unknown>';

    const validation = validateRuleBundle(item);
    if (!validation.valid) {
      errors.push({ id: ruleId, reason: validation.errors.join('; ') });
      continue;
    }

    const rule = item as RuleBundle;
    const info = insertStmt.run({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      conditionSource: rule.condition_source,
      recommendedAction: rule.recommended_action,
    });

    if (info.changes === 0) {
      skipped++;
    } else {
      imported++;
    }
  }

  return res.json({ imported, skipped, errors });
});

// POST /api/rules/registry/validate
router.post('/rules/registry/validate', requireAdmin, (req, res) => {
  const body = req.body as unknown;
  const result = validateRuleBundle(body);
  return res.json({ valid: result.valid, errors: result.errors });
});

// GET /api/rules/registry/stats
router.get('/rules/registry/stats', requireAdmin, (_req, res) => {
  const totalRow = sqlite.prepare('SELECT COUNT(*) as count FROM rules').get() as { count: number };
  const builtInRow = sqlite.prepare('SELECT COUNT(*) as count FROM rules WHERE built_in = 1').get() as { count: number };
  const pluginRow = sqlite.prepare('SELECT COUNT(*) as count FROM rules WHERE built_in = 0').get() as { count: number };
  const enabledRow = sqlite.prepare('SELECT COUNT(*) as count FROM rules WHERE enabled = 1').get() as { count: number };
  const disabledRow = sqlite.prepare('SELECT COUNT(*) as count FROM rules WHERE enabled = 0').get() as { count: number };

  return res.json({
    total_rules: totalRow.count,
    built_in: builtInRow.count,
    plugin: pluginRow.count,
    enabled: enabledRow.count,
    disabled: disabledRow.count,
  });
});

export default router;
