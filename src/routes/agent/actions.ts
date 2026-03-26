import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { requireAgent, requireAgentId, requireAdmin } from '../../middleware/auth';
import { sqlite } from '../../db/index';

const router = Router();

const VALID_ACTION_TYPES = new Set([
  'restart_container',
  'write_file',
  'exec_command',
  'http_request',
  'custom',
]);

const VALID_OUTCOMES = new Set(['success', 'failure', 'partial']);

// ─── POST /agent/actions ──────────────────────────────────────────────────────

router.post('/actions', requireAgent, requireAgentId, (req: Request, res: Response): void => {
  const agentId = req.agentId!;
  const body = req.body as {
    taskId?: unknown;
    actionType?: unknown;
    target?: unknown;
    payload?: unknown;
    notes?: unknown;
    outcome?: unknown;
  };

  // Validate taskId
  if (!body.taskId || typeof body.taskId !== 'string') {
    res.status(400).json({ error: 'invalid_params', detail: 'taskId is required' });
    return;
  }

  // Validate actionType
  if (!body.actionType || typeof body.actionType !== 'string' || !VALID_ACTION_TYPES.has(body.actionType)) {
    res.status(400).json({
      error: 'invalid_params',
      detail: 'actionType must be one of: restart_container, write_file, exec_command, http_request, custom',
    });
    return;
  }

  // Validate target
  if (!body.target || typeof body.target !== 'string') {
    res.status(400).json({ error: 'invalid_params', detail: 'target is required' });
    return;
  }

  // Validate payload (optional, must be object if present)
  if (body.payload !== undefined && body.payload !== null) {
    if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      res.status(400).json({ error: 'invalid_params', detail: 'payload must be an object' });
      return;
    }
  }

  // Validate notes (optional, max 1000 chars)
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      res.status(400).json({ error: 'invalid_params', detail: 'notes must be a string' });
      return;
    }
    if (body.notes.length > 1000) {
      res.status(400).json({ error: 'notes_too_long', detail: 'notes must not exceed 1000 characters' });
      return;
    }
  }

  // Validate outcome
  if (!body.outcome || typeof body.outcome !== 'string' || !VALID_OUTCOMES.has(body.outcome)) {
    res.status(400).json({
      error: 'invalid_params',
      detail: 'outcome must be one of: success, failure, partial',
    });
    return;
  }

  // Ownership check: task must exist, be claimed, and be claimed by this agent
  const task = sqlite
    .prepare(`SELECT id, status, claimed_by FROM tasks WHERE id = ?`)
    .get(body.taskId) as { id: string; status: string; claimed_by: string | null } | undefined;

  if (!task || task.claimed_by !== agentId || task.status !== 'claimed') {
    res.status(403).json({ error: 'task_not_claimed_by_you', code: 'forbidden' });
    return;
  }

  const actionId = crypto.randomUUID();
  const payloadStr = body.payload != null ? JSON.stringify(body.payload) : null;
  const notes = (body.notes as string | undefined) ?? null;

  sqlite
    .prepare(
      `INSERT INTO agent_actions (id, task_id, agent_id, action_type, target, payload, outcome, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(actionId, body.taskId, agentId, body.actionType, body.target, payloadStr, body.outcome, notes);

  // Append state_event
  sqlite
    .prepare(`INSERT INTO state_events (id, event_type, domain, payload) VALUES (?, ?, ?, ?)`)
    .run(
      crypto.randomUUID(),
      'action.logged',
      'agent',
      JSON.stringify({
        action_id: actionId,
        task_id: body.taskId,
        agent_id: agentId,
        action_type: body.actionType,
        outcome: body.outcome,
      })
    );

  const created = sqlite
    .prepare(`SELECT * FROM agent_actions WHERE id = ?`)
    .get(actionId) as {
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

  res.status(201).json({
    id: created.id,
    task_id: created.task_id,
    agent_id: created.agent_id,
    action_type: created.action_type,
    target: created.target,
    payload: created.payload != null ? (JSON.parse(created.payload) as unknown) : null,
    outcome: created.outcome,
    notes: created.notes,
    occurred_at: created.occurred_at,
  });
});

// ─── GET /agent/tasks/:id/actions ─────────────────────────────────────────────

router.get('/tasks/:id/actions', requireAdmin, (req: Request, res: Response): void => {
  const { id } = req.params;

  // Check task exists
  const task = sqlite
    .prepare(`SELECT id FROM tasks WHERE id = ?`)
    .get(id) as { id: string } | undefined;

  if (!task) {
    res.status(404).json({ error: 'task_not_found', code: 'not_found' });
    return;
  }

  const rows = sqlite
    .prepare(`SELECT * FROM agent_actions WHERE task_id = ? ORDER BY occurred_at ASC`)
    .all(id) as Array<{
      id: string;
      task_id: string | null;
      agent_id: string;
      action_type: string;
      target: string;
      payload: string | null;
      outcome: string;
      notes: string | null;
      occurred_at: string | null;
    }>;

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

  res.status(200).json({ actions });
});

export default router;
