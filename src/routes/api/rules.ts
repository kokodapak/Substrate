import { Router } from 'express';
import * as vm from 'node:vm';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { rules } from '../../db/schema';

const router = Router();

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

// GET /api/rules — returns all rules (without condition_source)
router.get('/', requireAdmin, (_req, res) => {
  const rows = db.select().from(rules).all();

  const result = rows.map((rule) => ({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    severity: rule.severity,
    enabled: rule.enabled === 1,
    built_in: rule.builtIn === 1,
    recommended_action: rule.recommendedAction,
  }));

  return res.json({ rules: result });
});

// PUT /api/rules/:id — update a rule
router.put('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const rule = db.select().from(rules).where(eq(rules.id, id)).get();

  if (!rule) {
    return res.status(404).json({ error: 'rule_not_found' });
  }

  const body = req.body as Record<string, unknown>;
  const isBuiltIn = rule.builtIn === 1;

  // For built-in rules, only `enabled` may be updated
  if (isBuiltIn) {
    const forbiddenFields = ['name', 'description', 'severity', 'condition_source', 'recommended_action'];
    for (const field of forbiddenFields) {
      if (field in body) {
        let detail: string;
        if (field === 'condition_source') {
          detail = 'Cannot update condition_source of built-in rule';
        } else {
          detail = `Cannot update ${field} of built-in rule`;
        }
        return res.status(400).json({ error: 'invalid_field', detail });
      }
    }
  }

  // Validate severity if provided
  if ('severity' in body) {
    const sev = body['severity'];
    if (typeof sev !== 'string' || !VALID_SEVERITIES.has(sev)) {
      return res.status(400).json({
        error: 'invalid_field',
        detail: 'severity must be one of: critical, high, medium, low',
      });
    }
  }

  // Validate condition_source if provided (non-built-in only)
  if ('condition_source' in body) {
    const src = body['condition_source'];
    if (typeof src !== 'string') {
      return res.status(400).json({ error: 'invalid_field', detail: 'condition_source must be a string' });
    }
    try {
      new vm.Script('(function(graphData){' + src + '})');
    } catch (err) {
      return res.status(400).json({
        error: 'invalid_field',
        detail: `condition_source failed compilation: ${String(err)}`,
      });
    }
  }

  // Build the update object
  const updates: Partial<{
    name: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    enabled: number;
    conditionSource: string;
    recommendedAction: string;
    updatedAt: string;
  }> = {};

  if ('enabled' in body) {
    const val = body['enabled'];
    if (typeof val !== 'boolean') {
      return res.status(400).json({ error: 'invalid_field', detail: 'enabled must be a boolean' });
    }
    updates.enabled = val ? 1 : 0;
  }

  if ('name' in body) {
    updates.name = body['name'] as string;
  }

  if ('description' in body) {
    updates.description = body['description'] as string;
  }

  if ('severity' in body) {
    updates.severity = body['severity'] as 'critical' | 'high' | 'medium' | 'low';
  }

  if ('condition_source' in body) {
    updates.conditionSource = body['condition_source'] as string;
  }

  if ('recommended_action' in body) {
    updates.recommendedAction = body['recommended_action'] as string;
  }

  updates.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.update(rules).set(updates).where(eq(rules.id, id)).run();

  const updated = db.select().from(rules).where(eq(rules.id, id)).get();

  if (!updated) {
    return res.status(500).json({ error: 'update_failed' });
  }

  return res.json({
    rule: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      severity: updated.severity,
      enabled: updated.enabled === 1,
      built_in: updated.builtIn === 1,
      condition_source: updated.conditionSource,
      recommended_action: updated.recommendedAction,
      created_at: updated.createdAt,
      updated_at: updated.updatedAt,
    },
  });
});

export default router;
