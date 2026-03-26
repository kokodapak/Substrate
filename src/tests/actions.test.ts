/**
 * actions.test.ts — Integration tests for agent action surface:
 *   POST /agent/actions
 *   GET  /agent/tasks/:id/actions
 *   GET  /api/actions
 */

process.env['DATABASE_URL'] = ':memory:';
process.env['SUBSTRATE_ADMIN_KEY'] = 'test-admin-key';
process.env['SUBSTRATE_AGENT_KEY'] = 'test-agent-key';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as crypto from 'crypto';

import { sqlite } from '../db/index';
import { app } from '../app';

function bootstrap(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS graph_snapshots (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      graph_data TEXT NOT NULL,
      domains TEXT DEFAULT '["services","files_configs"]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('container','process','app')),
      status TEXT CHECK(status IN ('running','stopped','exited','unknown')),
      image TEXT,
      ports TEXT DEFAULT '[]',
      env_key_names TEXT DEFAULT '[]',
      snapshot_id TEXT REFERENCES graph_snapshots(id),
      discovered_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files_configs (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      type TEXT CHECK(type IN ('env','docker-compose','package-json','config','other')),
      allowed INTEGER DEFAULT 0,
      snapshot_id TEXT REFERENCES graph_snapshots(id),
      discovered_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT REFERENCES graph_snapshots(id),
      domain TEXT NOT NULL,
      node_key TEXT NOT NULL,
      node_data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_id, node_key)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT CHECK(severity IN ('critical','high','medium','low')),
      enabled INTEGER DEFAULT 1,
      condition_source TEXT NOT NULL,
      recommended_action TEXT NOT NULL,
      built_in INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      rule_id TEXT REFERENCES rules(id),
      snapshot_id TEXT REFERENCES graph_snapshots(id),
      severity TEXT CHECK(severity IN ('critical','high','medium','low')),
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      recommended_action TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(rule_id, snapshot_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      finding_id TEXT REFERENCES findings(id),
      priority INTEGER NOT NULL,
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','claimed','done','skipped')),
      claimed_by TEXT,
      claimed_at TEXT,
      lock_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(finding_id)
    );

    CREATE TABLE IF NOT EXISTS state_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      domain TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS state_snapshots (
      id TEXT PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001',
      snapshot_data TEXT NOT NULL,
      last_scan_at TEXT NOT NULL,
      service_count INTEGER DEFAULT 0,
      finding_count INTEGER DEFAULT 0,
      critical_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS access_rules (
      id TEXT PRIMARY KEY,
      source TEXT CHECK(source IN ('botignore','botinclude')),
      pattern TEXT NOT NULL,
      domain TEXT DEFAULT 'any' CHECK(domain IN ('file','service','env','integration','any')),
      action TEXT CHECK(action IN ('deny','allow')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source, pattern, domain)
    );

    CREATE TABLE IF NOT EXISTS agent_actions (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id),
      agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      payload TEXT,
      outcome TEXT NOT NULL,
      notes TEXT,
      occurred_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add federation columns to tables if not already present.
  // better-sqlite3 does not support ALTER TABLE ADD COLUMN IF NOT EXISTS,
  // so we try each ALTER individually and ignore duplicate-column errors.
  for (const alter of [
    'ALTER TABLE graph_snapshots ADD COLUMN satellite_id TEXT',
    'ALTER TABLE findings ADD COLUMN satellite_id TEXT',
    'ALTER TABLE tasks ADD COLUMN satellite_id TEXT',
    'ALTER TABLE state_events ADD COLUMN satellite_id TEXT',
  ]) {
    try { sqlite.exec(alter); } catch { /* column already exists — ignore */ }
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS satellites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      agent_key_encrypted TEXT NOT NULL,
      last_sync_at TEXT,
      status TEXT DEFAULT 'offline',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/** Insert a claimed task owned by the given agent. */
function insertClaimedTask(agentId: string, overrides: { id?: string } = {}): string {
  const id = overrides.id ?? crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  const lockExpiresAt = new Date(Date.now() + 300_000).toISOString();

  sqlite.prepare(`
    INSERT INTO tasks (id, finding_id, priority, title, context, reasoning, status, claimed_by, claimed_at, lock_expires_at)
    VALUES (?, NULL, 3, 'Test Task', '{"test":true}', 'Test reasoning', 'claimed', ?, ?, ?)
  `).run(id, agentId, claimedAt, lockExpiresAt);

  return id;
}

/** Insert a pending task. */
function insertPendingTask(overrides: { id?: string } = {}): string {
  const id = overrides.id ?? crypto.randomUUID();

  sqlite.prepare(`
    INSERT INTO tasks (id, finding_id, priority, title, context, reasoning, status, claimed_by, claimed_at, lock_expires_at)
    VALUES (?, NULL, 3, 'Pending Task', '{"test":true}', 'Test reasoning', 'pending', NULL, NULL, NULL)
  `).run(id);

  return id;
}

const AGENT_HEADERS = {
  'x-api-key': 'test-agent-key',
  'x-agent-id': 'test-agent-001',
};

const AGENT_HEADERS_2 = {
  'x-api-key': 'test-agent-key',
  'x-agent-id': 'test-agent-002',
};

const ADMIN_HEADERS = { 'x-api-key': 'test-admin-key' };

const VALID_ACTION_BODY = {
  actionType: 'exec_command',
  target: '/usr/bin/systemctl restart nginx',
  outcome: 'success',
};

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── POST /agent/actions ──────────────────────────────────────────────────────

describe('POST /agent/actions', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/agent/actions').send(VALID_ACTION_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 201 with valid body and a claimed task', async () => {
    const taskId = insertClaimedTask('test-agent-001');

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ ...VALID_ACTION_BODY, taskId, payload: { cmd: 'restart' }, notes: 'Restarted nginx.' });

    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('task_id', taskId);
    expect(body).toHaveProperty('agent_id', 'test-agent-001');
    expect(body).toHaveProperty('action_type', 'exec_command');
    expect(body).toHaveProperty('target', '/usr/bin/systemctl restart nginx');
    expect(body).toHaveProperty('outcome', 'success');
    expect(body).toHaveProperty('notes', 'Restarted nginx.');
    expect(body).toHaveProperty('occurred_at');
    expect(body['payload']).toEqual({ cmd: 'restart' });
  });

  it('returns 403 when task is not claimed by this agent', async () => {
    const taskId = insertClaimedTask('test-agent-002');

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS) // agent-001 trying to log action on agent-002's task
      .send({ ...VALID_ACTION_BODY, taskId });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error', 'task_not_claimed_by_you');
    expect(res.body).toHaveProperty('code', 'forbidden');
  });

  it('returns 403 when task exists but is not in claimed status', async () => {
    const taskId = insertPendingTask();

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ ...VALID_ACTION_BODY, taskId });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error', 'task_not_claimed_by_you');
  });

  it('returns 400 when notes exceeds 1000 chars', async () => {
    const taskId = insertClaimedTask('test-agent-001');
    const longNotes = 'x'.repeat(1001);

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ ...VALID_ACTION_BODY, taskId, notes: longNotes });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'notes_too_long');
  });

  it('returns 400 with invalid actionType', async () => {
    const taskId = insertClaimedTask('test-agent-001');

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ ...VALID_ACTION_BODY, taskId, actionType: 'invalid_type' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });

  it('returns 400 when outcome is missing', async () => {
    const taskId = insertClaimedTask('test-agent-001');

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ taskId, actionType: 'exec_command', target: 'some-target' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });

  it('returns 400 when payload is not an object', async () => {
    const taskId = insertClaimedTask('test-agent-001');

    const res = await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ ...VALID_ACTION_BODY, taskId, payload: 'not-an-object' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });
});

// ─── GET /agent/tasks/:id/actions ─────────────────────────────────────────────

describe('GET /agent/tasks/:id/actions', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/agent/tasks/some-id/actions');
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app)
      .get('/agent/tasks/nonexistent-task-id/actions')
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'task_not_found');
    expect(res.body).toHaveProperty('code', 'not_found');
  });

  it('returns 200 with ordered actions', async () => {
    const taskId = insertClaimedTask('test-agent-001');

    // Log two actions
    await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ taskId, actionType: 'write_file', target: '/etc/nginx/nginx.conf', outcome: 'success' });

    await request(app)
      .post('/agent/actions')
      .set(AGENT_HEADERS)
      .send({ taskId, actionType: 'restart_container', target: 'nginx', outcome: 'partial' });

    const res = await request(app)
      .get(`/agent/tasks/${taskId}/actions`)
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    const body = res.body as { actions: unknown[] };
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions.length).toBeGreaterThanOrEqual(2);

    const first = body.actions[0] as Record<string, unknown>;
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('task_id', taskId);
    expect(first).toHaveProperty('agent_id');
    expect(first).toHaveProperty('action_type');
    expect(first).toHaveProperty('target');
    expect(first).toHaveProperty('outcome');
    expect(first).toHaveProperty('occurred_at');
  });

  it('returns 200 with empty array when task has no actions', async () => {
    const taskId = insertClaimedTask('test-agent-001');

    const res = await request(app)
      .get(`/agent/tasks/${taskId}/actions`)
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    const body = res.body as { actions: unknown[] };
    expect(body.actions).toEqual([]);
  });
});

// ─── GET /api/actions ─────────────────────────────────────────────────────────

describe('GET /api/actions', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/actions');
    expect(res.status).toBe(401);
  });

  it('returns 200 with pagination shape', async () => {
    const res = await request(app)
      .get('/api/actions')
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('actions');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit', 50);
    expect(body).toHaveProperty('offset', 0);
    expect(Array.isArray(body['actions'])).toBe(true);
    expect(typeof body['total']).toBe('number');
  });

  it('returns 200 filtered by agent_id', async () => {
    const uniqueAgentId = `filter-agent-${crypto.randomUUID()}`;
    const taskId = insertClaimedTask(uniqueAgentId);

    // Seed an action for uniqueAgentId
    sqlite.prepare(`
      INSERT INTO agent_actions (id, task_id, agent_id, action_type, target, outcome)
      VALUES (?, ?, ?, 'custom', 'target', 'success')
    `).run(crypto.randomUUID(), taskId, uniqueAgentId);

    const res = await request(app)
      .get(`/api/actions?agent_id=${uniqueAgentId}`)
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    const body = res.body as { actions: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const action of body.actions) {
      expect(action['agent_id']).toBe(uniqueAgentId);
    }
  });

  it('respects limit and offset params', async () => {
    const res = await request(app)
      .get('/api/actions?limit=2&offset=0')
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    const body = res.body as { actions: unknown[]; limit: number; offset: number };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.actions.length).toBeLessThanOrEqual(2);
  });

  it('returns 400 when limit exceeds 200', async () => {
    const res = await request(app)
      .get('/api/actions?limit=201')
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });

  it('returns 400 when limit is 0', async () => {
    const res = await request(app)
      .get('/api/actions?limit=0')
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid action_type filter', async () => {
    const res = await request(app)
      .get('/api/actions?action_type=bad_type')
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });
});
