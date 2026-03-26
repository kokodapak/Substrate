import { Router } from 'express';
import { eq, max, and } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { graphSnapshots, findings } from '../../db/schema';

const router = Router();

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_STATUSES = new Set(['open', 'acknowledged', 'resolved']);

// GET /api/findings — returns findings from the latest graph snapshot
router.get('/', requireAdmin, (req, res) => {
  const severityFilter = req.query['severity'] as string | undefined;
  const statusFilter = req.query['status'] as string | undefined;

  // Validate filters
  if (severityFilter !== undefined && !VALID_SEVERITIES.has(severityFilter)) {
    return res.status(400).json({
      error: 'invalid_params',
      detail: 'severity must be one of: critical, high, medium, low',
    });
  }

  if (statusFilter !== undefined && !VALID_STATUSES.has(statusFilter)) {
    return res.status(400).json({
      error: 'invalid_params',
      detail: 'status must be one of: open, acknowledged, resolved',
    });
  }

  // Get latest snapshot
  const latestRow = db
    .select({ maxVersion: max(graphSnapshots.version) })
    .from(graphSnapshots)
    .get();

  const latestVersion = latestRow?.maxVersion ?? null;

  if (latestVersion === null) {
    return res.json({ snapshot_version: null, findings: [] });
  }

  const snapshot = db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.version, latestVersion))
    .get();

  if (!snapshot) {
    return res.json({ snapshot_version: null, findings: [] });
  }

  // Build query conditions
  type FindingCondition = Parameters<typeof and>[0];
  const conditions: FindingCondition[] = [eq(findings.snapshotId, snapshot.id)];

  if (severityFilter) {
    conditions.push(
      eq(findings.severity, severityFilter as 'critical' | 'high' | 'medium' | 'low')
    );
  }

  if (statusFilter) {
    conditions.push(
      eq(findings.status, statusFilter as 'open' | 'acknowledged' | 'resolved')
    );
  }

  const rows = db
    .select()
    .from(findings)
    .where(and(...conditions))
    .all();

  const result = rows.map((f) => ({
    id: f.id,
    rule_id: f.ruleId,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    recommended_action: f.recommendedAction,
    status: f.status,
    created_at: f.createdAt,
  }));

  return res.json({ snapshot_version: latestVersion, findings: result });
});

export default router;
