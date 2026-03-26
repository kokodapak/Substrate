/**
 * graph-edges.test.ts — Tests for graph edges: schema, scan population,
 * API inclusion, diff, and the docker-socket-exposed-via-volume rule.
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
import * as crypto from 'crypto';
import * as vm from 'vm';

// Mock dockerode before importing scanner/app so the mock is in place
vi.mock('dockerode', () => {
  const mockInspect = vi.fn().mockResolvedValue({
    Config: { Env: ['DB_HOST=localhost', 'DB_PORT=5432'] },
    Mounts: [
      { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Mode: 'rw' },
      { Source: '/data/volumes/pgdata', Destination: '/var/lib/postgresql/data', Mode: 'rw' },
    ],
  });

  const MockDockerode = vi.fn().mockImplementation(() => ({
    listContainers: vi.fn().mockResolvedValue([
      {
        Id: 'abc123',
        Names: ['/web'],
        State: 'running',
        Image: 'nginx:latest',
        Ports: [
          { PublicPort: 8080, PrivatePort: 80, Type: 'tcp' },
        ],
      },
      {
        Id: 'def456',
        Names: ['/db'],
        State: 'running',
        Image: 'postgres:14',
        Ports: [],
      },
    ]),
    getContainer: vi.fn().mockReturnValue({ inspect: mockInspect }),
  }));

  return { default: MockDockerode };
});

import { sqlite, db } from '../db/index';
import { app } from '../app';
import { graphSnapshots, graphEdges } from '../db/schema';
import { eq, max } from 'drizzle-orm';

function bootstrap(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS graph_snapshots (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      graph_data TEXT NOT NULL,
      domains TEXT DEFAULT '["services","files_configs"]',
      created_at TEXT DEFAULT (datetime('now'))
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

  // Seed a minimal rule so the scan doesn't error
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

  // Seed the docker-socket-exposed-via-volume rule
  sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (
      'docker-socket-exposed-via-volume',
      'Docker Socket Exposed via Volume Mount',
      'Detects containers that mount the Docker socket file via a volume, granting them full Docker daemon access.',
      'high',
      'return graphData.edges && graphData.edges.some(e => e.edge_type === ''mounts_volume'' && e.to_node_key && e.to_node_key.includes(''/var/run/docker.sock''));',
      'Remove the Docker socket volume mount. If Docker-in-Docker is required, use a dedicated Docker daemon with access controls.',
      1
    )
  `).run();

  // Allow all services so the scanner doesn't default-deny them
  sqlite.prepare(`
    INSERT OR IGNORE INTO access_rules (id, source, pattern, domain, action)
    VALUES ('allow-all-services', 'botinclude', '*', 'service', 'allow')
  `).run();
}

const ADMIN = { 'x-api-key': 'test-admin-key' };

// Helper: insert a test snapshot with edges
function insertTestSnapshotWithEdges(
  version: number,
  edges: Array<{ fromNodeKey: string; toNodeKey: string; edgeType: 'depends_on' | 'exposes_port' | 'mounts_volume' | 'reads_env_file'; metadata?: string }>
): string {
  const snapshotId = crypto.randomUUID();
  db.insert(graphSnapshots).values({
    id: snapshotId,
    version,
    graphData: JSON.stringify({ services: [], files_configs: [], edges: edges.map((e, i) => ({ id: String(i), from_node_key: e.fromNodeKey, to_node_key: e.toNodeKey, edge_type: e.edgeType })) }),
    domains: '["services","files_configs"]',
  }).run();

  for (const edge of edges) {
    db.insert(graphEdges).values({
      id: crypto.randomUUID(),
      snapshotId,
      fromNodeKey: edge.fromNodeKey,
      toNodeKey: edge.toNodeKey,
      edgeType: edge.edgeType,
      metadata: edge.metadata ?? null,
    }).run();
  }

  return snapshotId;
}

function getMaxVersion(): number {
  const row = db.select({ maxVersion: max(graphSnapshots.version) }).from(graphSnapshots).get();
  return row?.maxVersion ?? 0;
}

let scanSnapshotVersion: number;

beforeAll(() => {
  bootstrap();
});

afterAll(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

// ─── POST /api/scan populates graph_edges ─────────────────────────────────────

describe('POST /api/scan — graph_edges population', () => {
  it('scan returns 200 and creates edges for mocked containers', async () => {
    const res = await request(app).post('/api/scan').set(ADMIN);
    expect(res.status).toBe(200);
    scanSnapshotVersion = res.body.snapshot_version as number;

    // Find the snapshot we just created
    const snapshot = db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.version, scanSnapshotVersion))
      .get();

    expect(snapshot).toBeDefined();

    // Query edges for this snapshot
    const edges = db
      .select()
      .from(graphEdges)
      .where(eq(graphEdges.snapshotId, snapshot!.id))
      .all();

    // 'web' container has 1 port binding → 1 exposes_port edge
    // Both containers have 2 mounts each → 4 mounts_volume edges
    // Total: 1 + 4 = 5 edges
    expect(edges.length).toBeGreaterThan(0);

    // Should have at least one exposes_port edge for the 'web' container
    const portEdges = edges.filter((e) => e.edgeType === 'exposes_port');
    expect(portEdges.length).toBeGreaterThanOrEqual(1);
    expect(portEdges[0]!.fromNodeKey).toBe('service:web');
    expect(portEdges[0]!.toNodeKey).toBe('port:8080');

    // Should have mounts_volume edges for docker.sock
    const mountEdges = edges.filter((e) => e.edgeType === 'mounts_volume');
    expect(mountEdges.length).toBeGreaterThanOrEqual(1);
    const sockEdge = mountEdges.find((e) => e.toNodeKey === 'volume:/var/run/docker.sock');
    expect(sockEdge).toBeDefined();
  });

  it('graph_data JSON in snapshot includes edges array', async () => {
    const snapshot = db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.version, scanSnapshotVersion))
      .get();

    expect(snapshot).toBeDefined();
    const graphData = JSON.parse(snapshot!.graphData) as { edges?: unknown[] };
    expect(Array.isArray(graphData.edges)).toBe(true);
    expect((graphData.edges ?? []).length).toBeGreaterThan(0);
  });
});

// ─── GET /api/graph includes edges ────────────────────────────────────────────

describe('GET /api/graph — includes edges', () => {
  it('returns graph_data with edges array after scan', async () => {
    const res = await request(app).get('/api/graph').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('graph_data');
    expect(Array.isArray(res.body.graph_data.edges)).toBe(true);
  });

  it('edges in response have expected shape', async () => {
    const res = await request(app).get('/api/graph').set(ADMIN);
    expect(res.status).toBe(200);
    const edges = res.body.graph_data.edges as unknown[];
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge).toHaveProperty('id');
      expect(edge).toHaveProperty('snapshot_id');
      expect(edge).toHaveProperty('from_node_key');
      expect(edge).toHaveProperty('to_node_key');
      expect(edge).toHaveProperty('edge_type');
    }
  });
});

// ─── GET /api/graph/diff includes edge_additions and edge_removals ────────────

describe('GET /api/graph/diff — edge_additions and edge_removals', () => {
  let diffFromVersion: number;
  let diffToVersion: number;

  beforeAll(() => {
    const base = getMaxVersion();
    diffFromVersion = base + 1;
    diffToVersion = base + 2;

    // Snapshot v1: has a port edge only
    insertTestSnapshotWithEdges(diffFromVersion, [
      { fromNodeKey: 'service:api', toNodeKey: 'port:3000', edgeType: 'exposes_port' },
    ]);

    // Snapshot v2: port edge gone, docker sock mount added
    insertTestSnapshotWithEdges(diffToVersion, [
      { fromNodeKey: 'service:api', toNodeKey: 'volume:/var/run/docker.sock', edgeType: 'mounts_volume' },
    ]);
  });

  it('returns edge_additions and edge_removals in diff response', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: String(diffToVersion) });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.edge_additions)).toBe(true);
    expect(Array.isArray(res.body.edge_removals)).toBe(true);
  });

  it('edge_additions contains the new mounts_volume edge', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: String(diffToVersion) });

    expect(res.status).toBe(200);
    const additions = res.body.edge_additions as Array<{ from_node_key: string; to_node_key: string; edge_type: string }>;
    const sockAddition = additions.find(
      (e) => e.edge_type === 'mounts_volume' && e.to_node_key === 'volume:/var/run/docker.sock'
    );
    expect(sockAddition).toBeDefined();
  });

  it('edge_removals contains the removed exposes_port edge', async () => {
    const res = await request(app)
      .get('/api/graph/diff')
      .set(ADMIN)
      .query({ from: String(diffFromVersion), to: String(diffToVersion) });

    expect(res.status).toBe(200);
    const removals = res.body.edge_removals as Array<{ from_node_key: string; to_node_key: string; edge_type: string }>;
    const portRemoval = removals.find(
      (e) => e.edge_type === 'exposes_port' && e.to_node_key === 'port:3000'
    );
    expect(portRemoval).toBeDefined();
  });
});

// ─── docker-socket-exposed-via-volume rule ────────────────────────────────────

const DOCKER_SOCK_RULE_SOURCE = `return graphData.edges && graphData.edges.some(e => e.edge_type === 'mounts_volume' && e.to_node_key && e.to_node_key.includes('/var/run/docker.sock'));`;

function evalRule(source: string, graphData: unknown): unknown {
  const script = new vm.Script(`(function(graphData) { ${source} })(graphData)`);
  const context = vm.createContext({ graphData });
  return script.runInContext(context, { timeout: 1000 });
}

describe('docker-socket-exposed-via-volume rule evaluation', () => {
  it('fires when edges include a mounts_volume edge to /var/run/docker.sock', () => {
    const graphData = {
      services: [],
      files_configs: [],
      edges: [
        {
          id: '1',
          edge_type: 'mounts_volume',
          from_node_key: 'service:agent',
          to_node_key: 'volume:/var/run/docker.sock',
          metadata: JSON.stringify({ source: '/var/run/docker.sock', destination: '/var/run/docker.sock', mode: 'rw' }),
        },
      ],
    };
    const result = evalRule(DOCKER_SOCK_RULE_SOURCE, graphData);
    expect(result).toBe(true);
  });

  it('does NOT fire when no mounts_volume edge to docker.sock exists', () => {
    const graphData = {
      services: [],
      files_configs: [],
      edges: [
        {
          id: '1',
          edge_type: 'exposes_port',
          from_node_key: 'service:web',
          to_node_key: 'port:8080',
          metadata: null,
        },
        {
          id: '2',
          edge_type: 'mounts_volume',
          from_node_key: 'service:db',
          to_node_key: 'volume:/data/pgdata',
          metadata: null,
        },
      ],
    };
    const result = evalRule(DOCKER_SOCK_RULE_SOURCE, graphData);
    expect(result).toBe(false);
  });

  it('does NOT fire when edges array is empty', () => {
    const graphData = { services: [], files_configs: [], edges: [] };
    const result = evalRule(DOCKER_SOCK_RULE_SOURCE, graphData);
    expect(result).toBe(false);
  });

  it('does NOT fire when edges field is missing', () => {
    const graphData = { services: [], files_configs: [] };
    const result = evalRule(DOCKER_SOCK_RULE_SOURCE, graphData);
    expect(result).toBeFalsy();
  });

  it('fires for path containing docker.sock even with prefix directory', () => {
    const graphData = {
      services: [],
      files_configs: [],
      edges: [
        {
          id: '1',
          edge_type: 'mounts_volume',
          from_node_key: 'service:sidecar',
          to_node_key: 'volume:/host/var/run/docker.sock',
          metadata: null,
        },
      ],
    };
    const result = evalRule(DOCKER_SOCK_RULE_SOURCE, graphData);
    expect(result).toBe(true);
  });
});
