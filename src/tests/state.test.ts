/**
 * state.test.ts — Integration tests for GET /api/state and GET /api/timeline
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
import { sqlite } from '../db/index';
import { app } from '../app';

const ADMIN_HEADER = { 'x-api-key': 'test-admin-key' };

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

  // Seed a minimal rule required by scanner
  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (
      'no-scan-data',
      'No Scan Data Available',
      'No services or file configs were discovered during the last scan.',
      'medium',
      'return (!graphData.services || graphData.services.length === 0) && (!graphData.files_configs || graphData.files_configs.length === 0);',
      'Verify the Docker socket is accessible and the scan completed successfully.',
      1
    )
  `).run();
}

function seedStateEvents(): void {
  // Insert 60 events so pagination tests work
  for (let i = 0; i < 60; i++) {
    const domain = i % 5 === 0 ? 'agent' : 'scan';
    const eventType = i % 3 === 0 ? 'scan.completed' : 'task.claimed';
    sqlite.prepare(`
      INSERT OR IGNORE INTO state_events (id, event_type, domain, payload, occurred_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `).run(
      `event-seed-${i}`,
      eventType,
      domain,
      JSON.stringify({ index: i, message: 'seeded event' }),
      `-${i} seconds`
    );
  }
}

function seedStateSnapshot(): void {
  sqlite.prepare(`
    INSERT OR REPLACE INTO state_snapshots (id, snapshot_data, last_scan_at, service_count, finding_count, critical_count)
    VALUES ('00000000-0000-0000-0000-000000000001', '{}', datetime('now'), 3, 5, 2)
  `).run();
}

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /api/state ───────────────────────────────────────────────────────────

describe('GET /api/state', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(401);
  });

  it('returns 404 with { error: no_state } when no snapshot exists', async () => {
    // Ensure no snapshot row exists for this isolated test
    sqlite.exec(`DELETE FROM state_snapshots WHERE id = '00000000-0000-0000-0000-000000000001'`);

    const res = await request(app).get('/api/state').set(ADMIN_HEADER);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no_state' });
  });

  it('returns 200 with correct shape after seeding snapshot', async () => {
    seedStateSnapshot();
    seedStateEvents();

    const res = await request(app).get('/api/state').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    expect(res.body).toHaveProperty('current');
    expect(res.body).toHaveProperty('recent_events');

    const { current } = res.body as {
      current: {
        service_count: number;
        finding_count: number;
        critical_count: number;
        last_scan_at: string;
      };
    };
    expect(typeof current.service_count).toBe('number');
    expect(typeof current.finding_count).toBe('number');
    expect(typeof current.critical_count).toBe('number');
    expect(typeof current.last_scan_at).toBe('string');
  });

  it('returns recent_events with parsed payload (not string)', async () => {
    const res = await request(app).get('/api/state').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { recent_events } = res.body as {
      recent_events: Array<{
        id: string;
        event_type: string;
        domain: string;
        payload: unknown;
        occurred_at: string;
      }>;
    };

    expect(Array.isArray(recent_events)).toBe(true);
    expect(recent_events.length).toBeGreaterThan(0);
    // payload must be an object, not a string
    for (const event of recent_events) {
      expect(typeof event.payload).toBe('object');
      expect(typeof event.id).toBe('string');
      expect(typeof event.event_type).toBe('string');
      expect(typeof event.domain).toBe('string');
      expect(typeof event.occurred_at).toBe('string');
    }
  });

  it('recent_events contains a scan.completed event with parsed payload', async () => {
    // Ensure at least one scan.completed event exists
    sqlite.prepare(`
      INSERT OR IGNORE INTO state_events (id, event_type, domain, payload, occurred_at)
      VALUES ('event-scan-completed-test', 'scan.completed', 'scan', '{"snapshot_version":1}', datetime('now'))
    `).run();

    const res = await request(app).get('/api/state').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { recent_events } = res.body as {
      recent_events: Array<{ event_type: string; payload: unknown }>;
    };

    const scanEvent = recent_events.find((e) => e.event_type === 'scan.completed');
    expect(scanEvent).toBeDefined();
    expect(typeof scanEvent!.payload).toBe('object');
  });

  it('returns at most 50 recent_events', async () => {
    const res = await request(app).get('/api/state').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { recent_events } = res.body as { recent_events: unknown[] };
    expect(recent_events.length).toBeLessThanOrEqual(50);
  });
});

// ─── GET /api/timeline ────────────────────────────────────────────────────────

describe('GET /api/timeline', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/timeline');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty result shape when no events', async () => {
    // Fresh in-memory DB with no events
    sqlite.exec(`DELETE FROM state_events`);
    sqlite.exec(`DELETE FROM state_snapshots WHERE id = '00000000-0000-0000-0000-000000000001'`);

    const res = await request(app).get('/api/timeline').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], total: 0, limit: 50, offset: 0 });
  });

  it('returns 200 with events after seeding', async () => {
    seedStateSnapshot();
    seedStateEvents();

    const res = await request(app).get('/api/timeline').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('events');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
    expect(Array.isArray(res.body.events)).toBe(true);
    expect((res.body as { total: number }).total).toBeGreaterThan(0);
  });

  it('filters by domain=agent', async () => {
    const res = await request(app).get('/api/timeline?domain=agent').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { events } = res.body as { events: Array<{ domain: string }> };
    for (const event of events) {
      expect(event.domain).toBe('agent');
    }
  });

  it('filters by event_type=scan.completed', async () => {
    const res = await request(app)
      .get('/api/timeline?event_type=scan.completed')
      .set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { events } = res.body as { events: Array<{ event_type: string }> };
    for (const event of events) {
      expect(event.event_type).toBe('scan.completed');
    }
  });

  it('respects limit=5 and returns at most 5 events', async () => {
    const res = await request(app).get('/api/timeline?limit=5').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const body = res.body as { events: unknown[]; limit: number };
    expect(body.events.length).toBeLessThanOrEqual(5);
    expect(body.limit).toBe(5);
  });

  it('clamps limit=300 to 200', async () => {
    const res = await request(app).get('/api/timeline?limit=300').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect((res.body as { limit: number }).limit).toBe(200);
  });

  it('returns 400 for limit=0', async () => {
    const res = await request(app).get('/api/timeline?limit=0').set(ADMIN_HEADER);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });

  it('returns 400 for negative offset', async () => {
    const res = await request(app).get('/api/timeline?offset=-1').set(ADMIN_HEADER);
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'invalid_params');
  });

  it('offset=0 with total > 50 returns correct pagination meta', async () => {
    const res = await request(app).get('/api/timeline?offset=0').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const body = res.body as { total: number; limit: number; offset: number };
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    // We seeded 60+ events
    expect(body.total).toBeGreaterThan(50);
  });

  it('filters by since (ISO datetime)', async () => {
    // Insert an old event
    sqlite.prepare(`
      INSERT OR IGNORE INTO state_events (id, event_type, domain, payload, occurred_at)
      VALUES ('event-old', 'scan.completed', 'scan', '{}', '2020-01-01T00:00:00.000Z')
    `).run();

    const since = '2025-01-01T00:00:00.000Z';
    const res = await request(app).get(`/api/timeline?since=${since}`).set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { events } = res.body as { events: Array<{ occurred_at: string }> };
    for (const event of events) {
      expect(event.occurred_at >= since).toBe(true);
    }
  });

  it('filters by until (ISO datetime)', async () => {
    const until = '2020-12-31T23:59:59.000Z';
    const res = await request(app).get(`/api/timeline?until=${until}`).set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    const { events } = res.body as { events: Array<{ occurred_at: string }> };
    for (const event of events) {
      expect(event.occurred_at <= until).toBe(true);
    }
  });
});
