import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { sqlite } from '../../db/index';

const router = Router();

const VALID_ACTION_TYPES = new Set([
  'restart_container',
  'write_file',
  'exec_command',
  'http_request',
  'custom',
]);

// ─── GET /api/actions ─────────────────────────────────────────────────────────

router.get('/actions', requireAdmin, (req: Request, res: Response): void => {
  const {
    agent_id,
    action_type,
    task_id,
    since,
    until,
    limit: limitParam,
    offset: offsetParam,
  } = req.query as Record<string, string | undefined>;

  // Validate action_type if provided
  if (action_type !== undefined && !VALID_ACTION_TYPES.has(action_type)) {
    res.status(400).json({
      error: 'invalid_params',
      detail: 'action_type must be one of: restart_container, write_file, exec_command, http_request, custom',
    });
    return;
  }

  // Validate limit
  let limit = 50;
  if (limitParam !== undefined) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      res.status(400).json({ error: 'invalid_params', detail: 'limit must be an integer between 1 and 200' });
      return;
    }
    limit = parsed;
  }

  // Validate offset
  let offset = 0;
  if (offsetParam !== undefined) {
    const parsed = parseInt(offsetParam, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      res.status(400).json({ error: 'invalid_params', detail: 'offset must be a non-negative integer' });
      return;
    }
    offset = parsed;
  }

  // Build WHERE clause dynamically
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (agent_id !== undefined) {
    conditions.push('agent_id = ?');
    params.push(agent_id);
  }

  if (action_type !== undefined) {
    conditions.push('action_type = ?');
    params.push(action_type);
  }

  if (task_id !== undefined) {
    conditions.push('task_id = ?');
    params.push(task_id);
  }

  if (since !== undefined) {
    conditions.push('occurred_at >= ?');
    params.push(since);
  }

  if (until !== undefined) {
    conditions.push('occurred_at <= ?');
    params.push(until);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  type ActionRow = {
    id: string;
    task_id: string | null;
    agent_id: string;
    action_type: string;
    target: string;
    payload: string | null;
    outcome: string;
    notes: string | null;
    occurred_at: string | null;
  };

  const countRow = sqlite
    .prepare(`SELECT COUNT(*) as total FROM agent_actions ${whereClause}`)
    .get(...params) as { total: number };

  const rows = sqlite
    .prepare(`SELECT * FROM agent_actions ${whereClause} ORDER BY occurred_at ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ActionRow[];

  const actions = rows.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    agent_id: r.agent_id,
    action_type: r.action_type,
    target: r.target,
    payload: r.payload != null ? (JSON.parse(r.payload) as unknown) : null,
    outcome: r.outcome,
    notes: r.notes,
    occurred_at: r.occurred_at,
  }));

  res.status(200).json({
    actions,
    total: countRow.total,
    limit,
    offset,
  });
});

export default router;
