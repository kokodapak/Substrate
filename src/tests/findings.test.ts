/**
 * findings.test.ts — Integration tests for GET /api/findings
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
import { graphSnapshots, findings, rules } from '../db/schema';
import { max, eq } from 'drizzle-orm';
import { app } from '../app';
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
  `);
}

const ADMIN = { 'x-api-key': 'test-admin-key' };

let testSnapshotVersion: number;
let testSnapshotId: string;

// Rule IDs seeded for findings tests
const RULE_CRITICAL = 'test-finding-rule-critical-' + Math.random().toString(36).slice(2);
const RULE_HIGH = 'test-finding-rule-high-' + Math.random().toString(36).slice(2);
const RULE_ACKNOWLEDGED = 'test-finding-rule-ack-' + Math.random().toString(36).slice(2);

beforeAll(() => {
  bootstrap();

  // Get current max version so we can insert on top
  const maxRow = db.select({ maxVersion: max(graphSnapshots.version) }).from(graphSnapshots).get();
  const baseVersion = maxRow?.maxVersion ?? 0;
  testSnapshotVersion = baseVersion + 1;
  testSnapshotId = crypto.randomUUID();

  // Insert test snapshot
  db.insert(graphSnapshots).values({
    id: testSnapshotId,
    version: testSnapshotVersion,
    graphData: JSON.stringify({}),
    domains: '["services","files_configs"]',
  }).run();

  // Insert test rules
  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (?, 'Critical Rule', 'A critical finding.', 'critical', 'return true;', 'Fix critical.', 0)
  `).run(RULE_CRITICAL);

  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (?, 'High Rule', 'A high finding.', 'high', 'return true;', 'Fix high.', 0)
  `).run(RULE_HIGH);

  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (?, 'Acknowledged Rule', 'An acknowledged finding.', 'medium', 'return true;', 'Fix ack.', 0)
  `).run(RULE_ACKNOWLEDGED);

  // Insert findings for the test snapshot
  sqlite.prepare(`
    INSERT OR IGNORE INTO findings (id, rule_id, snapshot_id, severity, title, detail, recommended_action, status)
    VALUES (?, ?, ?, 'critical', 'Critical Finding', 'Details.', 'Fix it.', 'open')
  `).run(crypto.randomUUID(), RULE_CRITICAL, testSnapshotId);

  sqlite.prepare(`
    INSERT OR IGNORE INTO findings (id, rule_id, snapshot_id, severity, title, detail, recommended_action, status)
    VALUES (?, ?, ?, 'high', 'High Finding', 'Details.', 'Fix it.', 'open')
  `).run(crypto.randomUUID(), RULE_HIGH, testSnapshotId);

  sqlite.prepare(`
    INSERT OR IGNORE INTO findings (id, rule_id, snapshot_id, severity, title, detail, recommended_action, status)
    VALUES (?, ?, ?, 'medium', 'Acknowledged Finding', 'Details.', 'Fix it.', 'acknowledged')
  `).run(crypto.randomUUID(), RULE_ACKNOWLEDGED, testSnapshotId);
});

afterAll(() => {
  sqlite.close();
});

// ─── GET /api/findings ────────────────────────────────────────────────────────

describe('GET /api/findings', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/findings');
    expect(res.status).toBe(401);
  });

  it('returns 200 with snapshot_version and findings after scan data exists', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.snapshot_version).toBe(testSnapshotVersion);
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.findings.length).toBeGreaterThanOrEqual(3);
  });

  it('returns correct finding shape', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN);
    expect(res.status).toBe(200);

    for (const finding of res.body.findings as Array<Record<string, unknown>>) {
      expect(finding).toHaveProperty('id');
      expect(finding).toHaveProperty('rule_id');
      expect(finding).toHaveProperty('severity');
      expect(finding).toHaveProperty('title');
      expect(finding).toHaveProperty('detail');
      expect(finding).toHaveProperty('recommended_action');
      expect(finding).toHaveProperty('status');
      expect(finding).toHaveProperty('created_at');
    }
  });

  it('filters by severity=critical', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN).query({ severity: 'critical' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.findings)).toBe(true);

    for (const finding of res.body.findings as Array<{ severity: string }>) {
      expect(finding.severity).toBe('critical');
    }

    // Must include the critical finding we inserted
    const criticalIds = (res.body.findings as Array<{ rule_id: string }>).map((f) => f.rule_id);
    expect(criticalIds).toContain(RULE_CRITICAL);
  });

  it('filters by status=acknowledged', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN).query({ status: 'acknowledged' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.findings)).toBe(true);

    for (const finding of res.body.findings as Array<{ status: string }>) {
      expect(finding.status).toBe('acknowledged');
    }
  });

  it('filters by status=open only returns open findings', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN).query({ status: 'open' });
    expect(res.status).toBe(200);

    for (const finding of res.body.findings as Array<{ status: string }>) {
      expect(finding.status).toBe('open');
    }
  });

  it('returns 400 for invalid severity', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN).query({ severity: 'extreme' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(app).get('/api/findings').set(ADMIN).query({ status: 'pending' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });
});
