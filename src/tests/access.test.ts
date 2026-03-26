/**
 * access.test.ts — Integration tests for /api/access/* endpoints
 *
 * env vars must be set BEFORE any module that reads them is imported,
 * because config.ts calls validateEnv() at module level and better-sqlite3
 * opens the file at import time in db/index.ts.
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

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /api/access ──────────────────────────────────────────────────────────

describe('GET /api/access', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/access');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct shape (empty lists initially)', async () => {
    const res = await request(app).get('/api/access').set(ADMIN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.botignore_rules)).toBe(true);
    expect(Array.isArray(res.body.botinclude_rules)).toBe(true);
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary).toHaveProperty('file');
    expect(res.body.summary).toHaveProperty('service');
    expect(res.body.summary).toHaveProperty('env');
    // Initially empty
    expect(res.body.botignore_rules).toHaveLength(0);
    expect(res.body.botinclude_rules).toHaveLength(0);
  });
});

// ─── PUT /api/access/botignore ────────────────────────────────────────────────

describe('PUT /api/access/botignore', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).put('/api/access/botignore').send({ content: '/etc/secrets' });
    expect(res.status).toBe(401);
  });

  it('returns 400 with invalid body (missing content)', async () => {
    const res = await request(app).put('/api/access/botignore').set(ADMIN).send({ not_content: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 with non-string content', async () => {
    const res = await request(app).put('/api/access/botignore').set(ADMIN).send({ content: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 200 with parsed_rules and blocked_nodes on valid content', async () => {
    const content = '# Deny sensitive\n/etc/secrets\nservice:redis-prod\nenv:DATABASE_URL';
    const res = await request(app).put('/api/access/botignore').set(ADMIN).send({ content });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('parsed_rules');
    expect(res.body).toHaveProperty('blocked_nodes');
    expect(typeof res.body.parsed_rules).toBe('number');
    expect(typeof res.body.blocked_nodes).toBe('number');
    expect(res.body.parsed_rules).toBe(3);
  });
});

// ─── PUT /api/access/botinclude ───────────────────────────────────────────────

describe('PUT /api/access/botinclude', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).put('/api/access/botinclude').send({ content: '/app/config' });
    expect(res.status).toBe(401);
  });

  it('returns 200 with parsed_rules and allowed_nodes on valid content', async () => {
    const content = '/app/config\nservice:app-server';
    const res = await request(app).put('/api/access/botinclude').set(ADMIN).send({ content });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('parsed_rules');
    expect(res.body).toHaveProperty('allowed_nodes');
    expect(typeof res.body.parsed_rules).toBe('number');
    expect(typeof res.body.allowed_nodes).toBe('number');
    expect(res.body.parsed_rules).toBe(2);
  });
});

// ─── GET /api/access/preview ──────────────────────────────────────────────────

describe('GET /api/access/preview', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/access/preview').query({ target: '/foo', domain: 'file' });
    expect(res.status).toBe(401);
  });

  it('returns 400 with missing target', async () => {
    const res = await request(app).get('/api/access/preview').set(ADMIN).query({ domain: 'file' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 with invalid domain', async () => {
    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/foo', domain: 'not-a-domain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 with missing domain', async () => {
    const res = await request(app).get('/api/access/preview').set(ADMIN).query({ target: '/foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('default_deny when no rules are set (uses fresh DB state)', async () => {
    // Clear all rules first
    await request(app).put('/api/access/botignore').set(ADMIN).send({ content: '' });
    await request(app).put('/api/access/botinclude').set(ADMIN).send({ content: '' });

    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/some/path', domain: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('deny');
    expect(res.body.matched_rule).toBeNull();
    expect(res.body.matched_source).toBe('default_deny');
  });

  it('auto_deny for sensitive env target name', async () => {
    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: 'DATABASE_SECRET_KEY', domain: 'env' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('deny');
    expect(res.body.matched_source).toBe('auto_deny');
  });

  it('auto_deny triggers for env domain with keyword TOKEN', async () => {
    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: 'STRIPE_TOKEN', domain: 'env' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('deny');
    expect(res.body.matched_source).toBe('auto_deny');
  });

  it('returns deny with matched_rule after setting botignore rule', async () => {
    // Set a botignore rule
    await request(app)
      .put('/api/access/botignore')
      .set(ADMIN)
      .send({ content: 'file:/etc/passwd' });

    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/etc/passwd', domain: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('deny');
    expect(res.body.matched_source).toBe('botignore');
    expect(res.body.matched_rule).toBe('/etc/passwd');
  });

  it('returns allow with matched_rule after setting botinclude rule', async () => {
    // Clear botignore, set botinclude allow rule
    await request(app).put('/api/access/botignore').set(ADMIN).send({ content: '' });
    await request(app)
      .put('/api/access/botinclude')
      .set(ADMIN)
      .send({ content: '/etc/test-file' });

    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/etc/test-file', domain: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('allow');
    expect(res.body.matched_source).toBe('botinclude');
    expect(res.body.matched_rule).toBe('/etc/test-file');
  });
});

// ─── Precedence test ──────────────────────────────────────────────────────────

describe('Precedence: botignore > botinclude', () => {
  it('botinclude allows /etc/test-file when no botignore rules', async () => {
    // Clear botignore, set botinclude
    await request(app).put('/api/access/botignore').set(ADMIN).send({ content: '' });
    await request(app)
      .put('/api/access/botinclude')
      .set(ADMIN)
      .send({ content: 'file:/etc/test-file' });

    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/etc/test-file', domain: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('allow');
    expect(res.body.matched_source).toBe('botinclude');
  });

  it('botignore deny takes precedence over botinclude allow', async () => {
    // Set botignore deny for /etc/** (applies to domain 'any')
    await request(app)
      .put('/api/access/botignore')
      .set(ADMIN)
      .send({ content: '/etc/**' });

    // botinclude still has /etc/test-file rule from previous test
    const res = await request(app)
      .get('/api/access/preview')
      .set(ADMIN)
      .query({ target: '/etc/test-file', domain: 'file' });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('deny');
    expect(res.body.matched_source).toBe('botignore');
  });
});
