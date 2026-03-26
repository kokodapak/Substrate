import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../../db/index';
import { stateSnapshots } from '../../db/schema';
import { requireAgent, requireAgentId } from '../../middleware/auth';
import { RateLimiter } from '../../services/rate-limiter';
import { sseBroadcaster } from '../../services/sse-broadcaster';

const router = Router();

// Rate limiter: 10 requests per second per agent_id
const nextActionLimiter = new RateLimiter(1000, 10);

// ─── GET /agent/next-action ───────────────────────────────────────────────────

router.get('/next-action', requireAgent, requireAgentId, (req: Request, res: Response): void => {
  const agentId = req.agentId!;

  // Rate limit check
  const rateCheck = nextActionLimiter.check(agentId);
  if (!rateCheck.allowed) {
    res.status(429).json({ error: 'rate_limit_exceeded', retry_after_ms: rateCheck.retryAfterMs });
    return;
  }

  // Use better-sqlite3 synchronous transaction for atomicity
  const result = sqlite.transaction(() => {
    // Step 1: Revert stale claims — unlock expired tasks
    const now = new Date().toISOString();
    const staleTasks = sqlite
      .prepare(
        `SELECT * FROM tasks WHERE status = 'claimed' AND lock_expires_at < ?`
      )
      .all(now) as Array<{
        id: string;
        finding_id: string | null;
        priority: number;
        title: string;
        context: string;
        reasoning: string;
        status: string;
        claimed_by: string | null;
        claimed_at: string | null;
        lock_expires_at: string | null;
        created_at: string;
        updated_at: string;
      }>;

    for (const staleTask of staleTasks) {
      sqlite
        .prepare(
          `UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?`
        )
        .run(new Date().toISOString(), staleTask.id);

      // Append state_event for each reverted task
      sqlite
        .prepare(
          `INSERT INTO state_events (id, event_type, domain, payload) VALUES (?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          'task.lock_expired',
          'agent',
          JSON.stringify({ task_id: staleTask.id, agent_id: staleTask.claimed_by })
        );

      sseBroadcaster.broadcast('task.available', { task_id: staleTask.id });
    }

    // Step 2: Find highest-priority pending task
    const pendingTask = sqlite
      .prepare(
        `SELECT * FROM tasks WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT 1`
      )
      .get() as {
        id: string;
        finding_id: string | null;
        priority: number;
        title: string;
        context: string;
        reasoning: string;
        status: string;
        claimed_by: string | null;
        claimed_at: string | null;
        lock_expires_at: string | null;
        created_at: string;
        updated_at: string;
      } | undefined;

    if (!pendingTask) {
      return null;
    }

    // Step 3: Claim the task
    const claimedAt = new Date().toISOString();
    const lockExpiresAt = new Date(Date.now() + 300_000).toISOString();
    const updatedAt = new Date().toISOString();

    sqlite
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, lock_expires_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(agentId, claimedAt, lockExpiresAt, updatedAt, pendingTask.id);

    // Step 4: Append state_event
    sqlite
      .prepare(
        `INSERT INTO state_events (id, event_type, domain, payload) VALUES (?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        'task.claimed',
        'agent',
        JSON.stringify({ task_id: pendingTask.id, agent_id: agentId })
      );

    return {
      id: pendingTask.id,
      title: pendingTask.title,
      priority: pendingTask.priority,
      reasoning: pendingTask.reasoning,
      context: JSON.parse(pendingTask.context) as unknown,
      lock_expires_at: lockExpiresAt,
    };
  })();

  if (!result) {
    res.status(204).send();
    return;
  }

  res.status(200).json({ task: result });
});

// ─── GET /agent/context ───────────────────────────────────────────────────────

router.get('/context', requireAgent, requireAgentId, async (_req: Request, res: Response): Promise<void> => {
  // Read from state_snapshots
  const snapshot = db
    .select()
    .from(stateSnapshots)
    .where(eq(stateSnapshots.id, '00000000-0000-0000-0000-000000000001'))
    .get();

  if (!snapshot) {
    res.status(200).json({
      snapshot_version: null,
      service_count: 0,
      finding_count: 0,
      critical_count: 0,
      last_scan_at: null,
      domains: [],
    });
    return;
  }

  // Get latest graph_snapshot version
  const latestSnapshot = sqlite
    .prepare(`SELECT MAX(version) as max_version FROM graph_snapshots`)
    .get() as { max_version: number | null } | undefined;

  const snapshotVersion = latestSnapshot?.max_version ?? null;

  res.status(200).json({
    snapshot_version: snapshotVersion,
    service_count: snapshot.serviceCount ?? 0,
    finding_count: snapshot.findingCount ?? 0,
    critical_count: snapshot.criticalCount ?? 0,
    last_scan_at: snapshot.lastScanAt,
    domains: ['services', 'files_configs'],
  });
});

// ─── POST /agent/tasks/:id/complete ──────────────────────────────────────────

router.post('/tasks/:id/complete', requireAgent, requireAgentId, (req: Request, res: Response): void => {
  const { id } = req.params;
  const agentId = req.agentId!;
  const body = req.body as { note?: string };

  // Validate note length
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > 500) {
      res.status(400).json({ error: 'note_too_long' });
      return;
    }
    note = body.note;
  }

  // Find task
  const task = sqlite
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .get(id) as {
      id: string;
      status: string;
      claimed_by: string | null;
    } | undefined;

  if (!task) {
    res.status(404).json({ error: 'task_not_found' });
    return;
  }

  if (task.status !== 'claimed') {
    res.status(409).json({ error: 'task_not_claimed' });
    return;
  }

  if (task.claimed_by !== agentId) {
    res.status(403).json({ error: 'not_owner' });
    return;
  }

  // Update task
  const updatedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`).run(updatedAt, id);

  // Append state_event
  sqlite
    .prepare(`INSERT INTO state_events (id, event_type, domain, payload) VALUES (?, ?, ?, ?)`)
    .run(
      crypto.randomUUID(),
      'task.completed',
      'agent',
      JSON.stringify({ task_id: id, agent_id: agentId, note })
    );

  sseBroadcaster.broadcast('task.removed', { task_id: id });

  res.status(200).json({ task_id: id, status: 'done' });
});

// ─── POST /agent/tasks/:id/skip ───────────────────────────────────────────────

router.post('/tasks/:id/skip', requireAgent, requireAgentId, (req: Request, res: Response): void => {
  const { id } = req.params;
  const agentId = req.agentId!;
  const body = req.body as { reason?: string };

  // Validate reason length
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.length > 500) {
      res.status(400).json({ error: 'reason_too_long' });
      return;
    }
    reason = body.reason;
  }

  // Find task
  const task = sqlite
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .get(id) as {
      id: string;
      status: string;
      claimed_by: string | null;
    } | undefined;

  if (!task) {
    res.status(404).json({ error: 'task_not_found' });
    return;
  }

  if (task.status !== 'claimed') {
    res.status(409).json({ error: 'task_not_claimed' });
    return;
  }

  if (task.claimed_by !== agentId) {
    res.status(403).json({ error: 'not_owner' });
    return;
  }

  // Update task
  const updatedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE tasks SET status = 'skipped', updated_at = ? WHERE id = ?`).run(updatedAt, id);

  // Append state_event
  sqlite
    .prepare(`INSERT INTO state_events (id, event_type, domain, payload) VALUES (?, ?, ?, ?)`)
    .run(
      crypto.randomUUID(),
      'task.skipped',
      'agent',
      JSON.stringify({ task_id: id, agent_id: agentId, reason })
    );

  sseBroadcaster.broadcast('task.removed', { task_id: id });

  res.status(200).json({ task_id: id, status: 'skipped' });
});

export default router;
