/**
 * registry.test.ts — Integration tests for plugin rule registry endpoints
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

  // Seed 5 built-in rules
  const builtInRules = [
    {
      id: 'container-exited-unexpectedly',
      name: 'Container Exited Unexpectedly',
      description: 'Detects containers that have exited.',
      severity: 'critical',
      conditionSource: `return graphData.services && graphData.services.some(s => s.status === 'exited');`,
      recommendedAction: 'Investigate container logs and restart the service.',
    },
    {
      id: 'docker-socket-exposed',
      name: 'Docker Socket Exposed',
      description: 'Detects services exposing the Docker daemon socket.',
      severity: 'high',
      conditionSource: `return graphData.services && graphData.services.some(s => { const ports = JSON.parse(s.ports || '[]'); return ports.some(p => p.host_port === 2375 || p.host_port === 2376); });`,
      recommendedAction: 'Remove the Docker socket port binding.',
    },
    {
      id: 'exposed-env-file',
      name: 'Exposed .env File',
      description: 'Detects .env files that are accessible.',
      severity: 'high',
      conditionSource: `return graphData.files_configs && graphData.files_configs.some(f => f.type === 'env' && f.allowed === 1);`,
      recommendedAction: 'Restrict access to .env files.',
    },
    {
      id: 'stopped-container',
      name: 'Stopped Container',
      description: 'Detects containers in a stopped state.',
      severity: 'low',
      conditionSource: `return graphData.services && graphData.services.some(s => s.status === 'stopped');`,
      recommendedAction: 'Review stopped containers.',
    },
    {
      id: 'no-scan-data',
      name: 'No Scan Data Available',
      description: 'No services or file configs were discovered.',
      severity: 'medium',
      conditionSource: `return (!graphData.services || graphData.services.length === 0) && (!graphData.files_configs || graphData.files_configs.length === 0);`,
      recommendedAction: 'Verify the Docker socket is accessible.',
    },
  ];

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (@id, @name, @description, @severity, @conditionSource, @recommendedAction, 1)
  `);

  for (const rule of builtInRules) {
    insert.run(rule);
  }

  // Federation columns
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

// Unique suffix to avoid collisions across test runs
const SUFFIX = Math.random().toString(36).slice(2, 8);

const PLUGIN_RULE_A = {
  id: `my-plugin-rule-${SUFFIX}`,
  name: 'My Plugin Rule',
  description: 'A plugin rule for testing.',
  severity: 'medium',
  condition_source: 'return true;',
  recommended_action: 'Fix it.',
};

const PLUGIN_RULE_B = {
  id: `another-plugin-rule-${SUFFIX}`,
  name: 'Another Plugin Rule',
  description: 'Second plugin rule.',
  severity: 'high',
  condition_source: 'return graphData.services && graphData.services.length > 0;',
  recommended_action: 'Review services.',
};

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /api/rules/registry/stats ───────────────────────────────────────────

describe('GET /api/rules/registry/stats', () => {
  it('returns 200 with correct counts', async () => {
    const res = await request(app).get('/api/rules/registry/stats').set(ADMIN);
    expect(res.status).toBe(200);
    expect(typeof res.body.total_rules).toBe('number');
    expect(typeof res.body.built_in).toBe('number');
    expect(typeof res.body.plugin).toBe('number');
    expect(typeof res.body.enabled).toBe('number');
    expect(typeof res.body.disabled).toBe('number');
    expect(res.body.total_rules).toBe(res.body.built_in + res.body.plugin);
    expect(res.body.total_rules).toBe(res.body.enabled + res.body.disabled);
    // All 5 built-in rules are seeded
    expect(res.body.built_in).toBeGreaterThanOrEqual(5);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/rules/registry/stats');
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/rules/registry/export ─────────────────────────────────────────

describe('POST /api/rules/registry/export', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/rules/registry/export');
    expect(res.status).toBe(401);
  });

  it('returns 200 with only non-built-in rules', async () => {
    // First import a plugin rule so export has something
    await request(app)
      .post('/api/rules/registry/import')
      .set(ADMIN)
      .send({ rules: [PLUGIN_RULE_A] });

    const res = await request(app).post('/api/rules/registry/export').set(ADMIN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);

    // No built-in rules in export
    const ids = (res.body.rules as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain('container-exited-unexpectedly');
    expect(ids).not.toContain('docker-socket-exposed');

    // Our plugin rule should be present
    expect(ids).toContain(PLUGIN_RULE_A.id);
  });

  it('includes condition_source in export', async () => {
    const res = await request(app).post('/api/rules/registry/export').set(ADMIN);
    expect(res.status).toBe(200);

    for (const rule of res.body.rules as Array<Record<string, unknown>>) {
      expect(rule).toHaveProperty('condition_source');
    }
  });
});

// ─── POST /api/rules/registry/import ─────────────────────────────────────────

describe('POST /api/rules/registry/import', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/rules/registry/import').send({ rules: [] });
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid bundle and imported=N', async () => {
    const res = await request(app)
      .post('/api/rules/registry/import')
      .set(ADMIN)
      .send({ rules: [PLUGIN_RULE_B] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(0);
  });

  it('returns 200 with duplicate bundle, imported=0 skipped=N (idempotent)', async () => {
    // PLUGIN_RULE_B was already imported in the previous test
    const res = await request(app)
      .post('/api/rules/registry/import')
      .set(ADMIN)
      .send({ rules: [PLUGIN_RULE_B] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.errors).toHaveLength(0);
  });

  it('returns 200 with one valid and one invalid rule — errors has the invalid one', async () => {
    const invalidRule = {
      id: 'INVALID ID WITH SPACES',
      name: 'Bad Rule',
      description: 'This rule has an invalid id.',
      severity: 'low',
      condition_source: 'return false;',
      recommended_action: 'Fix the id.',
    };

    const validRule = {
      id: `fresh-valid-rule-${SUFFIX}`,
      name: 'Fresh Valid Rule',
      description: 'A fresh valid rule.',
      severity: 'low',
      condition_source: 'return false;',
      recommended_action: 'Do nothing.',
    };

    const res = await request(app)
      .post('/api/rules/registry/import')
      .set(ADMIN)
      .send({ rules: [validRule, invalidRule] });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].id).toBe('INVALID ID WITH SPACES');
  });
});

// ─── POST /api/rules/registry/validate ───────────────────────────────────────

describe('POST /api/rules/registry/validate', () => {
  it('returns 200 { valid: true } for a valid rule', async () => {
    const res = await request(app)
      .post('/api/rules/registry/validate')
      .set(ADMIN)
      .send({
        id: 'my-valid-rule',
        name: 'My Valid Rule',
        description: 'Checks something.',
        severity: 'high',
        condition_source: 'return graphData.services && graphData.services.length > 0;',
        recommended_action: 'Investigate the services.',
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toHaveLength(0);
  });

  it('returns 200 { valid: false } for a rule with bad condition_source', async () => {
    const res = await request(app)
      .post('/api/rules/registry/validate')
      .set(ADMIN)
      .send({
        id: 'bad-source-rule',
        name: 'Bad Source Rule',
        description: 'Has invalid JS.',
        severity: 'low',
        condition_source: 'this is not valid { javascript ===',
        recommended_action: 'Fix the source.',
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('returns 200 { valid: false } for a rule with invalid id format', async () => {
    const res = await request(app)
      .post('/api/rules/registry/validate')
      .set(ADMIN)
      .send({
        id: 'INVALID_ID_FORMAT',
        name: 'Bad ID Rule',
        description: 'Has bad id.',
        severity: 'medium',
        condition_source: 'return true;',
        recommended_action: 'Fix the id.',
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.some((e: string) => e.includes('id'))).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/rules/registry/validate')
      .send({ id: 'test', name: 'Test', description: 'Test', severity: 'low', condition_source: 'return true;', recommended_action: 'Fix.' });
    expect(res.status).toBe(401);
  });
});
