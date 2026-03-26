/**
 * sse.test.ts — Tests for GET /agent/stream, /agent/stream/status, and sseBroadcaster
 */

process.env['DATABASE_URL'] = ':memory:';
process.env['SUBSTRATE_ADMIN_KEY'] = 'test-admin-key';
process.env['SUBSTRATE_AGENT_KEY'] = 'test-agent-key';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

import { sqlite } from '../db/index';
import { app } from '../app';
import { sseBroadcaster } from '../services/sse-broadcaster';

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
      severity TEXT,
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
      status TEXT DEFAULT 'pending',
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

const AGENT_HEADERS = {
  'x-api-key': 'test-agent-key',
  'x-agent-id': 'sse-test-agent',
};

const ADMIN_HEADERS = {
  'x-api-key': 'test-admin-key',
};

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /agent/stream — connection tests ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function destroyParser(res: any, callback: (err: Error | null, body: unknown) => void): void {
  res.destroy();
  callback(null, '');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function destroyOnDataParser(res: any, callback: (err: Error | null, body: unknown) => void): void {
  res.once('data', () => {
    res.destroy();
  });
  callback(null, '');
}

describe('GET /agent/stream', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/agent/stream')
      .timeout({ response: 1000 })
      .buffer(false)
      .parse(destroyParser);
    expect(res.status).toBe(401);
  });

  it('returns 400 without X-Agent-Id', async () => {
    const res = await request(app)
      .get('/agent/stream')
      .set({ 'x-api-key': 'test-agent-key' })
      .timeout({ response: 1000 })
      .buffer(false)
      .parse(destroyParser);
    expect(res.status).toBe(400);
  });

  it('returns 200 with content-type text/event-stream', async () => {
    const res = await request(app)
      .get('/agent/stream')
      .set(AGENT_HEADERS)
      .timeout({ response: 1000 })
      .buffer(false)
      .parse(destroyOnDataParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ─── GET /agent/stream/status ─────────────────────────────────────────────────

describe('GET /agent/stream/status', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/agent/stream/status');
    expect(res.status).toBe(401);
  });

  it('returns 200 with connected_agents and connection_count', async () => {
    const res = await request(app)
      .get('/agent/stream/status')
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connected_agents');
    expect(res.body).toHaveProperty('connection_count');
    expect(Array.isArray(res.body.connected_agents)).toBe(true);
    expect(typeof res.body.connection_count).toBe('number');
  });
});

// ─── sseBroadcaster unit tests ────────────────────────────────────────────────

describe('sseBroadcaster', () => {
  it('broadcast() calls res.write on all connected clients', () => {
    const writes: string[] = [];
    const mockRes = {
      write: (data: string) => { writes.push(data); },
    } as unknown as import('express').Response;

    sseBroadcaster.addClient('broadcast-test-agent', mockRes);
    sseBroadcaster.broadcast('task.available', { task_id: 'abc-123' });

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('event: task.available');
    expect(writes[0]).toContain('abc-123');

    sseBroadcaster.removeClient('broadcast-test-agent');
  });

  it('removeClient() removes the client so it no longer receives broadcasts', () => {
    const writes: string[] = [];
    const mockRes = {
      write: (data: string) => { writes.push(data); },
    } as unknown as import('express').Response;

    sseBroadcaster.addClient('remove-test-agent', mockRes);
    sseBroadcaster.removeClient('remove-test-agent');
    sseBroadcaster.broadcast('task.available', { task_id: 'xyz-456' });

    expect(writes.length).toBe(0);
  });

  it('getConnectedAgents() reflects current clients', () => {
    const mockRes = { write: () => {} } as unknown as import('express').Response;

    sseBroadcaster.addClient('agents-test-1', mockRes);
    sseBroadcaster.addClient('agents-test-2', mockRes);

    const agents = sseBroadcaster.getConnectedAgents();
    expect(agents).toContain('agents-test-1');
    expect(agents).toContain('agents-test-2');

    sseBroadcaster.removeClient('agents-test-1');
    sseBroadcaster.removeClient('agents-test-2');
  });

  it('getConnectionCount() returns correct count', () => {
    const mockRes = { write: () => {} } as unknown as import('express').Response;
    const before = sseBroadcaster.getConnectionCount();

    sseBroadcaster.addClient('count-test-agent', mockRes);
    expect(sseBroadcaster.getConnectionCount()).toBe(before + 1);

    sseBroadcaster.removeClient('count-test-agent');
    expect(sseBroadcaster.getConnectionCount()).toBe(before);
  });
});
