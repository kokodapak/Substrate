/**
 * graph.test.ts — Integration tests for GET /api/graph and GET /api/graph/diff
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
import { sqlite, db } from '../db/index';
import { graphSnapshots, graphNodes } from '../db/schema';
import { app } from '../app';
import { eq, max } from 'drizzle-orm';
import * as crypto from 'crypto';

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

    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT REFERENCES graph_snapshots(id),
      from_node_key TEXT NOT NULL,
      to_node_key TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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

const ADMIN = { 'x-api-key': 'test-admin-key' };

// Insert a synthetic snapshot and nodes for diff testing
// Returns the new snapshot version
function insertTestSnapshot(
  version: number,
  nodes: Array<{ domain: string; nodeKey: string; nodeData: object }>
): string {
  const snapshotId = crypto.randomUUID();
  db.insert(graphSnapshots).values({
    id: snapshotId,
    version,
    graphData: JSON.stringify({}),
    domains: '["services","files_configs"]',
  }).run();

  for (const node of nodes) {
    db.insert(graphNodes).values({
      id: crypto.randomUUID(),
      snapshotId,
      domain: node.domain,
      nodeKey: node.nodeKey,
      nodeData: JSON.stringify(node.nodeData),
    }).run();
  }

  return snapshotId;
}

// Get the current max version so we can build on top of it
function getMaxVersion(): number {
  const row = db.select({ maxVersion: max(graphSnapshots.version) }).from(graphSnapshots).get();
  return row?.maxVersion ?? 0;
}

let diffFromVersion: number;
let diffToVersion: number;

beforeAll(() => {
  bootstrap();

  // Insert two sequential snapshots for diff testing
  const base = getMaxVersion();
  diffFromVersion = base + 1;
  diffToVersion = base + 2;

  insertTestSnapshot(diffFromVersion, [
    {
      domain: 'services',
      nodeKey: 'services:app',
      nodeData: { name: 'app', status: 'running', image: 'nginx:latest' },
    },
    {
      domain: 'services',
      nodeKey: 'services:db',
      nodeData: { name: 'db', status: 'running', image: 'postgres:14' },
    },
    {
      domain: 'files_configs',
      nodeKey: 'files_configs:/etc/.env',
      nodeData: { path: '/etc/.env', type: 'env', allowed: 1 },
    },
  ]);

  insertTestSnapshot(diffToVersion, [
    // 'app' modified (image changed)
    {
      domain: 'services',
      nodeKey: 'services:app',
      nodeData: { name: 'app', status: 'running', image: 'nginx:1.25' },
    },
    // 'db' removed (not in v2)
    // 'cache' added
    {
      domain: 'services',
      nodeKey: 'services:cache',
      nodeData: { name: 'cache', status: 'running', image: 'redis:7' },
    },
    // files_configs node unchanged
    {
      domain: 'files_configs',
      nodeKey: 'files_configs:/etc/.env',
      nodeData: { path: '/etc/.env', type: 'env', allowed: 1 },
    },
  ]);
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /api/graph ───────────────────────────────────────────────────────────

describe('GET /api/graph', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/graph');
    expect(res.status).toBe(401);
  });

  it('returns 200 after snapshots exist with correct shape', async () => {
    // We've inserted snapshots in beforeAll, so the latest exists
    const res = await request(app).get('/api/graph').set(ADMIN);
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('number');
    expect(typeof res.body.created_at).toBe('string');
    expect(Array.isArray(res.body.domains)).toBe(true);
    expect(typeof res.body.graph_data).toBe('object');
    expect(res.body.graph_data).not.toBeNull();
    // graph_data must be parsed object, not a string
    expect(typeof res.body.graph_data).not.toBe('string');
  });

  it('returns latest version (highest version number)', async () => {
    const res = await request(app).get('/api/graph').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(diffToVersion);
  });
});

// ─── GET /api/graph/diff ──────────────────────────────────────────────────────

describe('GET /api/graph/diff', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/graph/diff').query({ from: '1' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when `from` is missing', async () => {
    const res = await request(app).get('/api/graph/diff').set(ADMIN);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when `from` is non-integer', async () => {
    const res = await request(app).get('/api/graph/diff').set(ADMIN).query({ from: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when `from` is negative', async () => {
    const res = await request(app).get('/api/graph/diff').set(ADMIN).query({ from: '-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when `to` is non-integer', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when from >= to (explicit to)', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffToVersion), to: String(diffFromVersion) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when from == to', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: String(diffFromVersion) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 404 when `from` version does not exist', async () => {
    const nonExistentVersion = 99999;
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(nonExistentVersion), to: String(diffToVersion) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('snapshot_not_found');
    expect(res.body.version).toBe(nonExistentVersion);
  });

  it('returns 404 when `to` version does not exist', async () => {
    const nonExistentVersion = 99998;
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: String(nonExistentVersion) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('snapshot_not_found');
    expect(res.body.version).toBe(nonExistentVersion);
  });

  it('returns 200 with correct diff shape after two snapshots exist', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: String(diffToVersion) });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe(diffFromVersion);
    expect(res.body.to).toBe(diffToVersion);
    expect(typeof res.body.domains).toBe('object');
    expect(res.body.domains).not.toBeNull();

    // services domain should be present
    expect(res.body.domains).toHaveProperty('services');
    const services = res.body.domains.services as {
      added: string[];
      removed: string[];
      modified: Array<{ node_key: string; before: object; after: object }>;
    };
    expect(Array.isArray(services.added)).toBe(true);
    expect(Array.isArray(services.removed)).toBe(true);
    expect(Array.isArray(services.modified)).toBe(true);

    // 'cache' was added in v2
    expect(services.added).toContain('services:cache');

    // 'db' was removed in v2
    expect(services.removed).toContain('services:db');

    // 'app' was modified (image changed)
    const modifiedApp = services.modified.find(
      (m: { node_key: string }) => m.node_key === 'services:app'
    );
    expect(modifiedApp).toBeDefined();
    expect(modifiedApp!.before).toHaveProperty('image', 'nginx:latest');
    expect(modifiedApp!.after).toHaveProperty('image', 'nginx:1.25');

    // files_configs domain — node is unchanged so modified should be empty
    expect(res.body.domains).toHaveProperty('files_configs');
    const filesConfigs = res.body.domains.files_configs as {
      added: string[];
      removed: string[];
      modified: Array<unknown>;
    };
    expect(filesConfigs.modified).toHaveLength(0);
    expect(filesConfigs.added).toHaveLength(0);
    expect(filesConfigs.removed).toHaveLength(0);
  });

  it('defaults `to` to latest version when omitted', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion) });

    expect(res.status).toBe(200);
    expect(res.body.from).toBe(diffFromVersion);
    expect(res.body.to).toBe(diffToVersion);
  });
});
