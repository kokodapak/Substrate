/**
 * rules.test.ts — Integration tests for GET /api/rules and PUT /api/rules/:id
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
import { rules } from '../db/schema';
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

  // Seed the 5 built-in rules (mirrors migrate.ts seeding)
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
}

const ADMIN = { 'x-api-key': 'test-admin-key' };

// Custom rule ID to insert for testing non-built-in updates
const CUSTOM_RULE_ID = 'test-custom-rule-' + Math.random().toString(36).slice(2);

beforeAll(() => {
  bootstrap();

  // Insert a custom (non-built-in) rule
  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (?, 'Custom Test Rule', 'A custom rule for testing.', 'medium', 'return true;', 'Fix it.', 0)
  `).run(CUSTOM_RULE_ID);
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /api/rules ───────────────────────────────────────────────────────────

describe('GET /api/rules', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/rules');
    expect(res.status).toBe(401);
  });

  it('returns 200 with rules array containing the 5 built-in rules', async () => {
    const res = await request(app).get('/api/rules').set(ADMIN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);

    const builtInRules = (res.body.rules as Array<{ built_in: boolean; id: string }>).filter(
      (r) => r.built_in === true
    );
    expect(builtInRules.length).toBeGreaterThanOrEqual(5);

    const ruleIds = builtInRules.map((r) => r.id);
    expect(ruleIds).toContain('container-exited-unexpectedly');
    expect(ruleIds).toContain('docker-socket-exposed');
    expect(ruleIds).toContain('exposed-env-file');
    expect(ruleIds).toContain('stopped-container');
    expect(ruleIds).toContain('no-scan-data');
  });

  it('returns rules with boolean enabled and built_in fields', async () => {
    const res = await request(app).get('/api/rules').set(ADMIN);
    expect(res.status).toBe(200);

    for (const rule of res.body.rules as Array<{ enabled: unknown; built_in: unknown }>) {
      expect(typeof rule.enabled).toBe('boolean');
      expect(typeof rule.built_in).toBe('boolean');
    }
  });

  it('does NOT include condition_source in response', async () => {
    const res = await request(app).get('/api/rules').set(ADMIN);
    expect(res.status).toBe(200);

    for (const rule of res.body.rules as Array<Record<string, unknown>>) {
      expect(rule).not.toHaveProperty('condition_source');
    }
  });
});

// ─── PUT /api/rules/:id ───────────────────────────────────────────────────────

describe('PUT /api/rules/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).put('/api/rules/container-exited-unexpectedly');
    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent rule', async () => {
    const res = await request(app)
      .put('/api/rules/non-existent-rule-id')
      .set(ADMIN)
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('rule_not_found');
  });

  it('allows toggling enabled on a built-in rule', async () => {
    const res = await request(app)
      .put('/api/rules/container-exited-unexpectedly')
      .set(ADMIN)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.rule.enabled).toBe(false);
    expect(res.body.rule.built_in).toBe(true);

    // Restore it
    await request(app)
      .put('/api/rules/container-exited-unexpectedly')
      .set(ADMIN)
      .send({ enabled: true });
  });

  it('returns 400 when updating condition_source of a built-in rule', async () => {
    const res = await request(app)
      .put('/api/rules/container-exited-unexpectedly')
      .set(ADMIN)
      .send({ condition_source: 'return false;' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_field');
  });

  it('returns 400 when updating name of a built-in rule', async () => {
    const res = await request(app)
      .put('/api/rules/container-exited-unexpectedly')
      .set(ADMIN)
      .send({ name: 'New Name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_field');
  });

  it('returns 400 when updating description of a built-in rule', async () => {
    const res = await request(app)
      .put('/api/rules/container-exited-unexpectedly')
      .set(ADMIN)
      .send({ description: 'New description' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_field');
  });

  it('allows updating condition_source for a custom rule with valid JS', async () => {
    const res = await request(app)
      .put(`/api/rules/${CUSTOM_RULE_ID}`)
      .set(ADMIN)
      .send({ condition_source: 'return graphData.services && graphData.services.length > 0;' });
    expect(res.status).toBe(200);
    expect(res.body.rule.id).toBe(CUSTOM_RULE_ID);
    expect(res.body.rule.condition_source).toBe(
      'return graphData.services && graphData.services.length > 0;'
    );
  });

  it('returns 400 when updating condition_source for custom rule with invalid JS', async () => {
    const res = await request(app)
      .put(`/api/rules/${CUSTOM_RULE_ID}`)
      .set(ADMIN)
      .send({ condition_source: 'this is not valid { javascript' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_field');
    expect(res.body.detail).toContain('condition_source failed compilation');
  });

  it('returns rule with condition_source and boolean fields in 200 response', async () => {
    const res = await request(app)
      .put(`/api/rules/${CUSTOM_RULE_ID}`)
      .set(ADMIN)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.rule).toHaveProperty('condition_source');
    expect(typeof res.body.rule.enabled).toBe('boolean');
    expect(typeof res.body.rule.built_in).toBe('boolean');
  });
});
