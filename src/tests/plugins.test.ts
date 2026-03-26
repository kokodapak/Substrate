/**
 * plugins.test.ts — Tests for the plugin rule system.
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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { sqlite } from '../db/index';
import { app } from '../app';
import { loadPluginRules } from '../services/plugin-loader';

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

const ADMIN = { 'x-api-key': 'test-admin-key' };

let tmpDir: string;

beforeAll(() => {
  bootstrap();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-plugins-test-'));
});

afterAll(() => {
  // Clean up temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    // ignore
  }
  sqlite.close();
});

// ─── GET /api/rules/plugins ───────────────────────────────────────────────────

describe('GET /api/rules/plugins', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/rules/plugins');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty plugins array when no plugins dir exists', async () => {
    const res = await request(app).get('/api/rules/plugins').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('plugins');
    expect(Array.isArray(res.body.plugins)).toBe(true);
    // pluginDescriptors is initialized to [] and no plugins dir scan has been triggered
    expect(res.body.plugins.length).toBe(0);
  });
});

// ─── loadPluginRules() unit tests ─────────────────────────────────────────────

describe('loadPluginRules()', () => {
  it('returns empty array when plugins dir does not exist', () => {
    const result = loadPluginRules('/non-existent-dir-xyz-12345');
    expect(result).toEqual([]);
  });

  it('returns correct descriptor for a valid plugin file', () => {
    const pluginContent = `
module.exports = [
  {
    id: 'test-plugin-rule',
    name: 'Test Plugin Rule',
    description: 'A test plugin rule.',
    severity: 'medium',
    condition_source: 'return graphData.services && graphData.services.length > 0;',
    recommended_action: 'Review the services.',
  }
];
    `.trim();

    const pluginPath = path.join(tmpDir, 'test-valid.js');
    fs.writeFileSync(pluginPath, pluginContent);

    const result = loadPluginRules(tmpDir);
    expect(result.length).toBeGreaterThanOrEqual(1);

    const descriptor = result.find((d) => d.id === 'test-plugin-rule');
    expect(descriptor).toBeDefined();
    expect(descriptor!.loaded).toBe(true);
    expect(descriptor!.name).toBe('Test Plugin Rule');
    expect(descriptor!.severity).toBe('medium');
    expect(descriptor!.source_path).toBe(pluginPath);
  });

  it('returns loaded=false when plugin file throws on require', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-plugins-bad-'));
    try {
      const pluginContent = `throw new Error('load error');`;
      fs.writeFileSync(path.join(tmpDir2, 'bad-plugin.js'), pluginContent);

      const result = loadPluginRules(tmpDir2);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const descriptor = result[0];
      expect(descriptor).toBeDefined();
      expect(descriptor!.loaded).toBe(false);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true });
    }
  });

  it('returns loaded=false for a plugin with an invalid rule object', () => {
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-plugins-invalid-'));
    try {
      // Missing required fields (no condition_source, no recommended_action)
      const pluginContent = `module.exports = [{ id: 'bad-rule', name: 'Bad Rule' }];`;
      fs.writeFileSync(path.join(tmpDir3, 'invalid-rule.js'), pluginContent);

      const result = loadPluginRules(tmpDir3);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const descriptor = result[0];
      expect(descriptor!.loaded).toBe(false);
    } finally {
      fs.rmSync(tmpDir3, { recursive: true });
    }
  });
});
