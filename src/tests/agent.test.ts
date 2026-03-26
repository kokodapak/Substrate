/**
 * agent.test.ts — Integration tests for GET /agent/next-action, /agent/context,
 * POST /agent/tasks/:id/complete, POST /agent/tasks/:id/skip
 *
 * env vars must be set BEFORE any module that reads them is imported.
 */

// Set env first — before any other import
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
import { runScan } from '../services/scanner';

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
  `);

  // Seed a rule that always fires so tasks are always created on scan
  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (
      'agent-test-always-fire',
      'Agent Test Rule',
      'Always fires for agent testing.',
      'high',
      'return true;',
      'Fix this issue.',
      0
    )
  `).run();
}

/** Insert a bare task directly into the DB and return its id. */
function insertTestTask(overrides: {
  id?: string;
  priority?: number;
  status?: string;
  claimed_by?: string | null;
  claimed_at?: string | null;
  lock_expires_at?: string | null;
} = {}): string {
  const id = overrides.id ?? crypto.randomUUID();
  const priority = overrides.priority ?? 3;
  const status = overrides.status ?? 'pending';
  const claimed_by = overrides.claimed_by ?? null;
  const claimed_at = overrides.claimed_at ?? null;
  const lock_expires_at = overrides.lock_expires_at ?? null;

  sqlite.prepare(`
    INSERT INTO tasks (id, finding_id, priority, title, context, reasoning, status, claimed_by, claimed_at, lock_expires_at)
    VALUES (?, NULL, ?, 'Test Task', '{"test":true}', 'Test reasoning', ?, ?, ?, ?)
  `).run(id, priority, status, claimed_by, claimed_at, lock_expires_at);

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

const ADMIN_KEY = { 'x-api-key': 'test-admin-key' };

beforeAll(async () => {
  bootstrap();
  // Run a scan to populate snapshot data, findings, and tasks if possible
  await runScan();
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /agent/next-action ───────────────────────────────────────────────────

describe('GET /agent/next-action', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/agent/next-action');
    expect(res.status).toBe(401);
  });

  it('returns 400 missing_agent_id when admin key used but no X-Agent-Id', async () => {
    const res = await request(app).get('/agent/next-action').set(ADMIN_KEY);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'missing_agent_id');
  });

  it('returns 204 when no pending tasks exist (after claiming all)', async () => {
    // Claim all pending tasks first via repeated calls
    let claimedCount = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
      if (r.status === 204) break;
      claimedCount++;
      if (claimedCount > 100) break; // safety
    }

    // Now no tasks should be pending
    const res = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(res.status).toBe(204);
  });

  it('returns 200 with correct task shape when a task exists', async () => {
    // Insert a new pending task
    insertTestTask();

    const res = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('task');

    const task = res.body.task as Record<string, unknown>;
    expect(task).toHaveProperty('id');
    expect(task).toHaveProperty('title');
    expect(task).toHaveProperty('priority');
    expect(task).toHaveProperty('reasoning');
    expect(task).toHaveProperty('context');
    expect(task).toHaveProperty('lock_expires_at');

    // context must be a parsed object, not a string
    expect(typeof task['context']).toBe('object');
    expect(task['context']).not.toBeNull();
    expect(typeof task['priority']).toBe('number');
  });

  it('returns 204 on second call from same agent (first task already claimed)', async () => {
    // Insert a pending task and claim it
    insertTestTask();

    const first = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(first.status).toBe(200);

    // Second call — no more pending tasks
    const second = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(second.status).toBe(204);
  });

  it('reverts stale claim and returns it as claimable', async () => {
    // Insert a task with a past lock_expires_at
    const pastTime = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const staleId = insertTestTask({
      status: 'claimed',
      claimed_by: 'some-other-agent',
      claimed_at: new Date(Date.now() - 360_000).toISOString(),
      lock_expires_at: pastTime,
    });

    // The GET /next-action should revert the stale claim and return the task
    const res = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(staleId);
  });
});

// ─── GET /agent/context ───────────────────────────────────────────────────────

describe('GET /agent/context', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/agent/context');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct shape after scan', async () => {
    const res = await request(app).get('/agent/context').set(AGENT_HEADERS);
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('snapshot_version');
    expect(body).toHaveProperty('service_count');
    expect(body).toHaveProperty('finding_count');
    expect(body).toHaveProperty('critical_count');
    expect(body).toHaveProperty('last_scan_at');
    expect(body).toHaveProperty('domains');
    expect(Array.isArray(body['domains'])).toBe(true);

    // After scan, snapshot_version should be a number
    expect(typeof body['snapshot_version']).toBe('number');
    // last_scan_at should be a non-null string
    expect(typeof body['last_scan_at']).toBe('string');
    // domains should include services and files_configs
    expect(body['domains']).toContain('services');
    expect(body['domains']).toContain('files_configs');
  });

  it('returns correct counts after scan', async () => {
    const res = await request(app).get('/agent/context').set(AGENT_HEADERS);
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect(typeof body['service_count']).toBe('number');
    expect(typeof body['finding_count']).toBe('number');
    expect(typeof body['critical_count']).toBe('number');
  });
});

// ─── POST /agent/tasks/:id/complete ──────────────────────────────────────────

describe('POST /agent/tasks/:id/complete', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/agent/tasks/some-id/complete');
    expect(res.status).toBe(401);
  });

  it('returns 400 missing_agent_id when X-Agent-Id is missing', async () => {
    const res = await request(app)
      .post('/agent/tasks/some-id/complete')
      .set({ 'x-api-key': 'test-agent-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_agent_id');
  });

  it('returns 404 task_not_found for nonexistent task', async () => {
    const res = await request(app)
      .post('/agent/tasks/nonexistent-task-id/complete')
      .set(AGENT_HEADERS);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('task_not_found');
  });

  it('returns 409 task_not_claimed when task is pending', async () => {
    const pendingId = insertTestTask({ status: 'pending' });

    const res = await request(app)
      .post(`/agent/tasks/${pendingId}/complete`)
      .set(AGENT_HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('task_not_claimed');
  });

  it('returns 403 not_owner when claimed by a different agent', async () => {
    // Insert a task claimed by a different agent
    const claimedAt = new Date().toISOString();
    const lockExpiresAt = new Date(Date.now() + 300_000).toISOString();
    const claimedId = insertTestTask({
      status: 'claimed',
      claimed_by: 'other-agent',
      claimed_at: claimedAt,
      lock_expires_at: lockExpiresAt,
    });

    const res = await request(app)
      .post(`/agent/tasks/${claimedId}/complete`)
      .set(AGENT_HEADERS);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_owner');
  });

  it('returns 200 with correct shape when completing owned task', async () => {
    // Insert a pending task, then claim it via next-action
    insertTestTask();
    const claimRes = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(claimRes.status).toBe(200);
    const taskId = (claimRes.body.task as { id: string }).id;

    const res = await request(app)
      .post(`/agent/tasks/${taskId}/complete`)
      .set(AGENT_HEADERS)
      .send({ note: 'Fixed it.' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('task_id', taskId);
    expect(res.body).toHaveProperty('status', 'done');
  });

  it('returns 409 task_not_claimed when completing an already-done task', async () => {
    // Insert a pending task, claim it, then complete it, then try to complete again
    insertTestTask();
    const claimRes = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(claimRes.status).toBe(200);
    const taskId = (claimRes.body.task as { id: string }).id;

    await request(app)
      .post(`/agent/tasks/${taskId}/complete`)
      .set(AGENT_HEADERS);

    const res = await request(app)
      .post(`/agent/tasks/${taskId}/complete`)
      .set(AGENT_HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('task_not_claimed');
  });
});

// ─── POST /agent/tasks/:id/skip ───────────────────────────────────────────────

describe('POST /agent/tasks/:id/skip', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/agent/tasks/some-id/skip');
    expect(res.status).toBe(401);
  });

  it('returns 400 missing_agent_id when X-Agent-Id is missing', async () => {
    const res = await request(app)
      .post('/agent/tasks/some-id/skip')
      .set({ 'x-api-key': 'test-agent-key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_agent_id');
  });

  it('returns 404 task_not_found for nonexistent task', async () => {
    const res = await request(app)
      .post('/agent/tasks/nonexistent-task-id/skip')
      .set(AGENT_HEADERS);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('task_not_found');
  });

  it('returns 409 task_not_claimed when task is pending', async () => {
    const pendingId = insertTestTask({ status: 'pending' });

    const res = await request(app)
      .post(`/agent/tasks/${pendingId}/skip`)
      .set(AGENT_HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('task_not_claimed');
  });

  it('returns 403 not_owner when claimed by a different agent', async () => {
    const claimedAt = new Date().toISOString();
    const lockExpiresAt = new Date(Date.now() + 300_000).toISOString();
    const claimedId = insertTestTask({
      status: 'claimed',
      claimed_by: 'other-agent',
      claimed_at: claimedAt,
      lock_expires_at: lockExpiresAt,
    });

    const res = await request(app)
      .post(`/agent/tasks/${claimedId}/skip`)
      .set(AGENT_HEADERS);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_owner');
  });

  it('returns 200 with correct shape when skipping owned task', async () => {
    // Insert a pending task, claim it, then skip it
    insertTestTask();
    const claimRes = await request(app).get('/agent/next-action').set(AGENT_HEADERS);
    expect(claimRes.status).toBe(200);
    const taskId = (claimRes.body.task as { id: string }).id;

    const res = await request(app)
      .post(`/agent/tasks/${taskId}/skip`)
      .set(AGENT_HEADERS)
      .send({ reason: 'Not applicable.' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('task_id', taskId);
    expect(res.body).toHaveProperty('status', 'skipped');
  });
});

// ─── Context with no scan data ────────────────────────────────────────────────

describe('GET /agent/context — no scan data', () => {
  it('returns 200 with nulls when no state_snapshot row exists', async () => {
    // Delete state_snapshots row to simulate no scan
    sqlite.prepare(`DELETE FROM state_snapshots`).run();

    const res = await request(app).get('/agent/context').set(AGENT_HEADERS);
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect(body['snapshot_version']).toBeNull();
    expect(body['service_count']).toBe(0);
    expect(body['finding_count']).toBe(0);
    expect(body['critical_count']).toBe(0);
    expect(body['last_scan_at']).toBeNull();
    expect(body['domains']).toEqual([]);
  });
});
