/**
 * journey.test.ts — E2E tests for the 3 primary user journeys.
 *
 * Runs against a real in-process Express app with a real SQLite in-memory DB.
 * No external server needed — supertest drives everything.
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

import { sqlite } from '../../db/index';
import { app } from '../../app';

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
      type TEXT,
      status TEXT,
      image TEXT,
      ports TEXT DEFAULT '[]',
      env_key_names TEXT DEFAULT '[]',
      snapshot_id TEXT,
      discovered_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS files_configs (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      type TEXT,
      allowed INTEGER DEFAULT 0,
      snapshot_id TEXT,
      discovered_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT,
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
      rule_id TEXT,
      snapshot_id TEXT,
      severity TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      recommended_action TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(rule_id, snapshot_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      finding_id TEXT,
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
      source TEXT,
      pattern TEXT NOT NULL,
      domain TEXT DEFAULT 'any',
      action TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source, pattern, domain)
    );
  `);

  // Seed built-in rules (needed for scanner rule evaluation)
  sqlite.exec(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES
      ('container-exited-unexpectedly', 'Container Exited Unexpectedly', 'Detects exited containers.', 'critical',
       'return graphData.services && graphData.services.some(s => s.status === ''exited'');',
       'Investigate container logs.', 1),
      ('no-scan-data', 'No Scan Data Available', 'No data found.', 'medium',
       'return (!graphData.services || graphData.services.length === 0) && (!graphData.files_configs || graphData.files_configs.length === 0);',
       'Verify Docker socket.', 1);
  `);
}

const ADMIN = { 'x-api-key': 'test-admin-key' };
const AGENT = { 'x-api-key': 'test-agent-key' };

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── Journey 1: First-time scan and finding review ────────────────────────────

describe('Journey 1: first-time scan and finding review', () => {
  it('GET /health → 200 with status, version, uptime_s, db', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('0.1.0');
    expect(typeof res.body.uptime_s).toBe('number');
    expect(res.body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(res.body.db).toBe('ok');
  });

  it('POST /api/scan → 200 with summary (handles missing Docker gracefully)', async () => {
    const res = await request(app).post('/api/scan').set(ADMIN);
    // Scanner handles missing Docker gracefully — either 200 or 429 (rate limit)
    expect([200, 429]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('snapshot_version');
      expect(res.body).toHaveProperty('services_discovered');
      expect(res.body).toHaveProperty('files_discovered');
      expect(res.body).toHaveProperty('findings_produced');
      expect(res.body).toHaveProperty('tasks_promoted');
      expect(res.body).toHaveProperty('duration_ms');
    }
  });

  it('GET /api/graph → 200 with snapshot data', async () => {
    const res = await request(app).get('/api/graph').set(ADMIN);
    expect(res.status).toBe(200);
    // Either a snapshot exists or we get an empty response
    expect(typeof res.body).toBe('object');
  });

  it('GET /api/findings → 200', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('findings');
    expect(Array.isArray(res.body.findings)).toBe(true);
  });

  it('GET /api/state → 200 or 404 (state exists only after scan)', async () => {
    const res = await request(app).get('/api/state').set(ADMIN);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('current');
      expect(typeof res.body.current.service_count).toBe('number');
      expect(typeof res.body.current.finding_count).toBe('number');
    }
  });
});

// ─── Journey 2: Agent claims and completes a task ─────────────────────────────

describe('Journey 2: agent claims and completes a task', () => {
  let insertedTaskId: string;
  const agentId = 'e2e-test-agent-' + crypto.randomUUID().slice(0, 8);

  beforeAll(() => {
    // Insert a test task directly to ensure there's something to claim
    insertedTaskId = crypto.randomUUID();

    // Insert a finding first (task requires a finding_id due to UNIQUE constraint)
    const findingId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO graph_snapshots (id, version, graph_data) VALUES (?, 1, '{}')`
      )
      .run(snapshotId);

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO findings (id, rule_id, snapshot_id, severity, title, detail, recommended_action, status)
         VALUES (?, 'no-scan-data', ?, 'medium', 'E2E Test Finding', 'Test finding for e2e.', 'Fix it.', 'open')`
      )
      .run(findingId, snapshotId);

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO tasks (id, finding_id, priority, title, context, reasoning, status)
         VALUES (?, ?, 1, 'E2E Test Task', '{"details":"test"}', 'Test reasoning', 'pending')`
      )
      .run(insertedTaskId, findingId);
  });

  it('GET /agent/next-action → 200 with task or 204 if none', async () => {
    const res = await request(app)
      .get('/agent/next-action')
      .set(AGENT)
      .set('X-Agent-Id', agentId);

    expect([200, 204, 429]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body).toHaveProperty('task');
      expect(res.body.task).toHaveProperty('id');
      expect(res.body.task).toHaveProperty('title');
    }
  });

  it('POST /agent/tasks/:id/complete → 200 after claiming task', async () => {
    // Manually claim the inserted task as our agentId
    sqlite
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, lock_expires_at = ?
         WHERE id = ?`
      )
      .run(
        agentId,
        new Date().toISOString(),
        new Date(Date.now() + 300_000).toISOString(),
        insertedTaskId
      );

    const res = await request(app)
      .post(`/agent/tasks/${insertedTaskId}/complete`)
      .set(AGENT)
      .set('X-Agent-Id', agentId)
      .send({ note: 'E2E test completion' });

    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe(insertedTaskId);
    expect(res.body.status).toBe('done');
  });

  it('GET /api/timeline → 200 with task.completed event', async () => {
    const res = await request(app)
      .get('/api/timeline')
      .set(ADMIN)
      .query({ event_type: 'task.completed' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('events');
    expect(Array.isArray(res.body.events)).toBe(true);

    const completedEvents = (res.body.events as Array<{ event_type: string; payload: { task_id?: string } }>)
      .filter((e) => e.event_type === 'task.completed');

    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    const ourEvent = completedEvents.find((e) => e.payload.task_id === insertedTaskId);
    expect(ourEvent).toBeDefined();
  });
});

// ─── Journey 3: Access control round-trip ─────────────────────────────────────

describe('Journey 3: access control round-trip', () => {
  // Clear access rules before this journey to avoid cross-test interference
  beforeAll(() => {
    sqlite.exec(`DELETE FROM access_rules`);
  });

  it('PUT /api/access/botignore with deny rule → 200', async () => {
    const res = await request(app)
      .put('/api/access/botignore')
      .set(ADMIN)
      .send({ content: '/etc/passwd\n*.env' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('parsed_rules');
    expect(res.body.parsed_rules).toBe(2);
    expect(typeof res.body.blocked_nodes).toBe('number');
  });

  it('GET /api/access → 200 with deny rules present', async () => {
    const res = await request(app).get('/api/access').set(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('botignore_rules');
    expect(Array.isArray(res.body.botignore_rules)).toBe(true);
    expect(res.body.botignore_rules.length).toBeGreaterThanOrEqual(1);

    const rule = (res.body.botignore_rules as Array<{ pattern: string; action: string }>).find(
      (r) => r.pattern === '/etc/passwd'
    );
    expect(rule).toBeDefined();
    expect(rule!.action).toBe('deny');
  });

  it('GET /api/access/preview for denied path → result=deny', async () => {
    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/etc/passwd', domain: 'file' });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('deny');
  });

  it('PUT /api/access/botinclude with allow rule for specific path → 200', async () => {
    const res = await request(app)
      .put('/api/access/botinclude')
      .set(ADMIN)
      .send({ content: '/api/public\n/health' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('parsed_rules');
    expect(res.body.parsed_rules).toBe(2);
  });

  it('GET /api/access → includes both botignore and botinclude rules', async () => {
    const res = await request(app).get('/api/access').set(ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.botignore_rules.length).toBeGreaterThanOrEqual(1);
    expect(res.body.botinclude_rules.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/access/preview for allowed path → result=allow', async () => {
    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/api/public', domain: 'file' });

    expect(res.status).toBe(200);
    // /api/public is in botinclude — should be allow
    expect(res.body.result).toBe('allow');
  });
});
