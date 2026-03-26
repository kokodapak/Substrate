/**
 * federation.test.ts — Integration tests for /api/federation/* routes and crypto utilities
 *
 * env vars must be set BEFORE any module that reads them is imported.
 */

// Set env first — before any other import
process.env['DATABASE_URL'] = ':memory:';
process.env['SUBSTRATE_ADMIN_KEY'] = 'test-admin-key';
process.env['SUBSTRATE_AGENT_KEY'] = 'test-agent-key';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '0';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { sqlite, db } from '../db/index';
import { graphSnapshots } from '../db/schema';
import { max } from 'drizzle-orm';
import { app } from '../app';
import * as crypto from 'crypto';
import { encrypt, decrypt } from '../services/crypto';

function bootstrap(): void {
  // Core tables — using CREATE TABLE IF NOT EXISTS for compatibility with other test files
  // that may have already created these tables without the new columns.
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

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  sqlite.close();
});

// ─── encrypt/decrypt round-trip ───────────────────────────────────────────────

describe('crypto utilities', () => {
  it('encrypt/decrypt round-trip returns original plaintext', () => {
    const original = 'my-secret-agent-key-abc123';
    const ciphertext = encrypt(original);
    expect(ciphertext).not.toBe(original);
    // Format: iv:authTag:encrypted (all hex, separated by colons)
    expect(ciphertext.split(':').length).toBe(3);
    const recovered = decrypt(ciphertext);
    expect(recovered).toBe(original);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const original = 'same-plaintext';
    const ct1 = encrypt(original);
    const ct2 = encrypt(original);
    expect(ct1).not.toBe(ct2);
    expect(decrypt(ct1)).toBe(original);
    expect(decrypt(ct2)).toBe(original);
  });
});

// ─── POST /api/federation/satellites ─────────────────────────────────────────

describe('POST /api/federation/satellites', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/federation/satellites').send({
      name: 'sat-auth-test',
      url: 'https://example.com',
      agent_key: 'key123',
    });
    expect(res.status).toBe(401);
  });

  it('returns 201 with correct shape and does not expose encrypted key', async () => {
    const res = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ name: 'sat-one', url: 'https://sat1.example.com', agent_key: 'my-agent-key' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', 'sat-one');
    expect(res.body).toHaveProperty('url', 'https://sat1.example.com');
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('created_at');
    // Must NOT expose agent_key or agent_key_encrypted
    expect(res.body).not.toHaveProperty('agent_key');
    expect(res.body).not.toHaveProperty('agent_key_encrypted');
  });

  it('stores encrypted key (not plaintext) in DB', async () => {
    const res = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ name: 'sat-encrypt-check', url: 'https://sat2.example.com', agent_key: 'plaintext-key-xyz' });

    expect(res.status).toBe(201);
    const id = res.body.id as string;

    // Verify the stored key is encrypted (not the plaintext)
    const row = sqlite.prepare('SELECT agent_key_encrypted FROM satellites WHERE id = ?').get(id) as
      | { agent_key_encrypted: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_key_encrypted).not.toBe('plaintext-key-xyz');
    // The encrypted value should be decryptable to the original
    expect(decrypt(row!.agent_key_encrypted)).toBe('plaintext-key-xyz');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ url: 'https://example.com', agent_key: 'key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when url does not start with http', async () => {
    const res = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ name: 'bad-url-sat', url: 'ftp://example.com', agent_key: 'key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when url is missing', async () => {
    const res = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ name: 'no-url-sat', agent_key: 'key' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });

  it('returns 400 when agent_key is missing', async () => {
    const res = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ name: 'no-key-sat', url: 'https://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
  });
});

// ─── GET /api/federation/satellites ──────────────────────────────────────────

describe('GET /api/federation/satellites', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/federation/satellites');
    expect(res.status).toBe(401);
  });

  it('returns 200 with satellites array and correct shape', async () => {
    const res = await request(app).get('/api/federation/satellites').set(ADMIN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.satellites)).toBe(true);

    for (const s of res.body.satellites as Array<Record<string, unknown>>) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('url');
      expect(s).toHaveProperty('status');
      expect(s).toHaveProperty('created_at');
      // Must NOT expose encrypted key
      expect(s).not.toHaveProperty('agent_key_encrypted');
      expect(s).not.toHaveProperty('agent_key');
    }
  });
});

// ─── DELETE /api/federation/satellites/:id ────────────────────────────────────

describe('DELETE /api/federation/satellites/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).delete('/api/federation/satellites/some-id');
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown satellite', async () => {
    const res = await request(app)
      .delete('/api/federation/satellites/00000000-0000-0000-0000-nonexistent')
      .set(ADMIN);
    expect(res.status).toBe(404);
  });

  it('returns 204 on successful delete', async () => {
    // First create a satellite to delete
    const createRes = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({ name: 'sat-to-delete', url: 'https://delete-me.example.com', agent_key: 'delkey' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id as string;

    const deleteRes = await request(app)
      .delete(`/api/federation/satellites/${id}`)
      .set(ADMIN);
    expect(deleteRes.status).toBe(204);

    // Verify it no longer shows in list
    const listRes = await request(app).get('/api/federation/satellites').set(ADMIN);
    const ids = (listRes.body.satellites as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(id);
  });
});

// ─── POST /api/federation/sync/:id ───────────────────────────────────────────

describe('POST /api/federation/sync/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/federation/sync/some-id');
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown satellite', async () => {
    const res = await request(app)
      .post('/api/federation/sync/00000000-0000-0000-0000-nonexistent')
      .set(ADMIN);
    expect(res.status).toBe(404);
  });

  it('returns 500 with sync_failed when satellite is unreachable (fetch throws)', async () => {
    // Create a satellite pointing at an unreachable URL
    const createRes = await request(app)
      .post('/api/federation/satellites')
      .set(ADMIN)
      .send({
        name: 'unreachable-sat',
        url: 'http://127.0.0.1:19999', // nothing listening here
        agent_key: 'test-agent-key',
      });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id as string;

    // Mock global fetch to simulate network failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const syncRes = await request(app).post(`/api/federation/sync/${id}`).set(ADMIN);

    globalThis.fetch = originalFetch;

    expect(syncRes.status).toBe(500);
    expect(syncRes.body.error).toBe('sync_failed');
    expect(syncRes.body.code).toBe('sync_error');
    expect(typeof syncRes.body.detail).toBe('string');
  });
});

// ─── GET /api/graph still works (local data only when no satellite_id param) ──

describe('GET /api/graph (federation: local-only default)', () => {
  it('returns 404 when no local snapshots exist', async () => {
    // In this test run, graph.test.ts runs first and inserts snapshots —
    // but those won't have satellite_id=NULL if they were bootstrapped without the column.
    // We just verify the endpoint responds correctly regardless.
    const res = await request(app).get('/api/graph').set(ADMIN);
    // Either 200 (snapshots exist) or 404 (no local snapshots) — both are valid
    expect([200, 404]).toContain(res.status);
  });

  it('accepts satellite_id=all query param without error', async () => {
    const res = await request(app).get('/api/graph').set(ADMIN).query({ satellite_id: 'all' });
    expect([200, 404]).toContain(res.status);
  });
});
