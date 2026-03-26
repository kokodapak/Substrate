import '../config'; // Ensure env is validated first
import path from 'path';
import fs from 'fs';
import { sqlite, db } from './index';
import { rules } from './schema';

// Run raw SQL migrations from the migrations/ directory
function runMigrations(): void {
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.log('No migrations directory found, skipping migrations.');
    return;
  }

  // Create migrations tracking table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set<string>(
    (sqlite.prepare('SELECT filename FROM __migrations').all() as { filename: string }[]).map(
      (r) => r.filename
    )
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
    sqlite.prepare('INSERT INTO __migrations (filename) VALUES (?)').run(file);
    console.log(`Applied migration: ${file}`);
  }
}

// Create all tables directly (no migration files needed for initial schema)
function createTables(): void {
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

function seedBuiltInRules(): void {
  const builtInRules = [
    {
      id: 'container-exited-unexpectedly',
      name: 'Container Exited Unexpectedly',
      description: 'Detects containers that have exited, which may indicate a crash or misconfiguration.',
      severity: 'critical' as const,
      conditionSource: `return graphData.services && graphData.services.some(s => s.status === 'exited');`,
      recommendedAction: 'Investigate container logs and restart the service. Check for misconfigurations or dependency failures.',
    },
    {
      id: 'docker-socket-exposed',
      name: 'Docker Socket Exposed',
      description: 'Detects services exposing the Docker daemon socket on a network port, which is a critical security risk.',
      severity: 'high' as const,
      conditionSource: `return graphData.services && graphData.services.some(s => { const ports = JSON.parse(s.ports || '[]'); return ports.some(p => p.host_port === 2375 || p.host_port === 2376); });`,
      recommendedAction: 'Remove the Docker socket port binding. Use a reverse proxy with authentication if remote Docker access is required.',
    },
    {
      id: 'exposed-env-file',
      name: 'Exposed .env File',
      description: 'Detects .env files that are accessible (allowed=1), which may expose secrets.',
      severity: 'high' as const,
      conditionSource: `return graphData.files_configs && graphData.files_configs.some(f => f.type === 'env' && f.allowed === 1);`,
      recommendedAction: 'Restrict access to .env files. Ensure they are listed in .gitignore and not served by the web server.',
    },
    {
      id: 'stopped-container',
      name: 'Stopped Container',
      description: 'Detects containers in a stopped state that may be unused or require restart.',
      severity: 'low' as const,
      conditionSource: `return graphData.services && graphData.services.some(s => s.status === 'stopped');`,
      recommendedAction: 'Review stopped containers. Remove unused ones or restart services that should be running.',
    },
    {
      id: 'no-scan-data',
      name: 'No Scan Data Available',
      description: 'No services or file configs were discovered during the last scan, which may indicate a scan failure.',
      severity: 'medium' as const,
      conditionSource: `return (!graphData.services || graphData.services.length === 0) && (!graphData.files_configs || graphData.files_configs.length === 0);`,
      recommendedAction: 'Verify the Docker socket is accessible and the scan completed successfully. Check agent connectivity.',
    },
  ];

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (@id, @name, @description, @severity, @conditionSource, @recommendedAction, 1)
  `);

  const insertMany = sqlite.transaction((rows: typeof builtInRules) => {
    for (const row of rows) {
      insert.run(row);
    }
  });

  insertMany(builtInRules);
  console.log('Built-in rules seeded (INSERT OR IGNORE).');
}

// Main
createTables();
runMigrations();
seedBuiltInRules();
console.log('Database migration complete.');

// Prevent drizzle from complaining about unused import
void db;
