/**
 * scanner.test.ts — System Scanner integration tests
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

// Import db utilities after env is set
import { sqlite } from '../db/index';
import { app } from '../app';

// Run migrations / create tables for the in-memory DB
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

  // Seed a minimal rule for testing
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

const ADMIN_HEADER = { 'x-api-key': 'test-admin-key' };

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── POST /api/scan ───────────────────────────────────────────────────────────

describe('POST /api/scan', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/scan');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct response shape when authenticated', async () => {
    const res = await request(app).post('/api/scan').set(ADMIN_HEADER);
    expect(res.status).toBe(200);

    // Verify all required fields are present
    expect(res.body).toHaveProperty('snapshot_version');
    expect(res.body).toHaveProperty('services_discovered');
    expect(res.body).toHaveProperty('files_discovered');
    expect(res.body).toHaveProperty('findings_produced');
    expect(res.body).toHaveProperty('tasks_promoted');
    expect(res.body).toHaveProperty('duration_ms');

    // Verify types
    expect(typeof res.body.snapshot_version).toBe('number');
    expect(typeof res.body.services_discovered).toBe('number');
    expect(typeof res.body.files_discovered).toBe('number');
    expect(typeof res.body.findings_produced).toBe('number');
    expect(typeof res.body.tasks_promoted).toBe('number');
    expect(typeof res.body.duration_ms).toBe('number');

    // First scan should be version 1
    expect(res.body.snapshot_version).toBe(1);
  });

  it('returns 429 on second call within 10 seconds', async () => {
    // First call (may be first or second scan, rate limiter is per-instance)
    await request(app).post('/api/scan').set(ADMIN_HEADER);

    // Second call should be rate-limited
    const res2 = await request(app).post('/api/scan').set(ADMIN_HEADER);
    expect(res2.status).toBe(429);
    expect(res2.body).toHaveProperty('error', 'rate_limit_exceeded');
    expect(res2.body).toHaveProperty('retry_after_ms');
    expect(typeof res2.body.retry_after_ms).toBe('number');
  });
});

// ─── GET /api/services ────────────────────────────────────────────────────────

describe('GET /api/services', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/services');
    expect(res.status).toBe(401);
  });

  it('returns correct shape when authenticated', async () => {
    const res = await request(app).get('/api/services').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('services');
    expect(Array.isArray(res.body.services)).toBe(true);
    // snapshot_version is either a number (if a scan ran) or null
    const sv = res.body.snapshot_version;
    expect(sv === null || typeof sv === 'number').toBe(true);
  });

  it('returns services array after a scan has run', async () => {
    // A scan was already run in the scan tests above; just verify shape
    const res = await request(app).get('/api/services').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);
    // Each service, if present, should have parsed ports and env_key_names
    for (const svc of res.body.services as unknown[]) {
      expect(svc).toHaveProperty('ports');
      expect(svc).toHaveProperty('env_key_names');
      expect(Array.isArray((svc as { ports: unknown[] }).ports)).toBe(true);
      expect(Array.isArray((svc as { env_key_names: unknown[] }).env_key_names)).toBe(true);
    }
  });
});

// ─── GET /api/files ───────────────────────────────────────────────────────────

describe('GET /api/files', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/files');
    expect(res.status).toBe(401);
  });

  it('returns correct shape when authenticated', async () => {
    const res = await request(app).get('/api/files').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('files');
    expect(Array.isArray(res.body.files)).toBe(true);
    const sv = res.body.snapshot_version;
    expect(sv === null || typeof sv === 'number').toBe(true);
  });

  it('returns files array after a scan has run', async () => {
    const res = await request(app).get('/api/files').set(ADMIN_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.files)).toBe(true);
    // Each file, if present, should have a boolean allowed field
    for (const f of res.body.files as unknown[]) {
      expect(f).toHaveProperty('path');
      expect(f).toHaveProperty('allowed');
      expect(typeof (f as { allowed: unknown }).allowed).toBe('boolean');
    }
  });
});
