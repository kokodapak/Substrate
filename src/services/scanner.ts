import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import Dockerode from 'dockerode';
import { eq, max } from 'drizzle-orm';
import { db, sqlite } from '../db/index';
import {
  graphSnapshots,
  graphNodes,
  services,
  filesConfigs,
  rules,
  findings,
  tasks,
  stateEvents,
} from '../db/schema';
import { config } from '../config';
import { evaluateAccess } from './access-evaluator';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredService {
  id: string;
  name: string;
  type: 'container' | 'process' | 'app';
  status: 'running' | 'stopped' | 'exited' | 'unknown';
  image: string;
  ports: Array<{ host_port: number; container_port: number; protocol: string }>;
  envKeyNames: string[];
}

interface DiscoveredFile {
  id: string;
  path: string;
  type: 'env' | 'docker-compose' | 'package-json' | 'config' | 'other';
  allowed: 0 | 1;
}

export interface ScanResult {
  snapshotVersion: number;
  servicesDiscovered: number;
  filesDiscovered: number;
  findingsProduced: number;
  tasksPromoted: number;
  durationMs: number;
}

// ─── Docker discovery ─────────────────────────────────────────────────────────

function mapDockerStatus(state: string): 'running' | 'stopped' | 'exited' | 'unknown' {
  switch (state) {
    case 'running':
      return 'running';
    case 'created':
    case 'paused':
    case 'restarting':
      return 'stopped';
    case 'exited':
    case 'dead':
      return 'exited';
    default:
      return 'unknown';
  }
}

async function discoverDockerContainers(): Promise<DiscoveredService[]> {
  try {
    const docker = new Dockerode({ socketPath: config.dockerSocketPath });
    const containers = await docker.listContainers({ all: true });

    const discovered: DiscoveredService[] = [];

    for (const container of containers) {
      // Strip leading slash from name
      const name = (container.Names[0] ?? container.Id).replace(/^\//, '');
      const status = mapDockerStatus(container.State);
      const image = container.Image;

      // Parse port bindings
      const ports: Array<{ host_port: number; container_port: number; protocol: string }> = [];
      if (container.Ports) {
        for (const p of container.Ports) {
          if (p.PublicPort !== undefined && p.PrivatePort !== undefined) {
            ports.push({
              host_port: p.PublicPort,
              container_port: p.PrivatePort,
              protocol: p.Type ?? 'tcp',
            });
          }
        }
      }

      // Inspect for env key names (we only store key names, never values)
      let envKeyNames: string[] = [];
      try {
        const inspected = await docker.getContainer(container.Id).inspect();
        const envVars = inspected.Config?.Env ?? [];
        envKeyNames = envVars
          .map((e: string) => e.split('=')[0] ?? '')
          .filter((k: string) => k.length > 0);
      } catch {
        // Inspect may fail for some containers — skip env keys
      }

      discovered.push({
        id: crypto.randomUUID(),
        name,
        type: 'container',
        status,
        image,
        ports,
        envKeyNames,
      });
    }

    return discovered;
  } catch (err) {
    console.warn('[scanner] Docker discovery failed (socket unavailable?):', String(err));
    return [];
  }
}

// ─── Filesystem discovery ─────────────────────────────────────────────────────

const ENV_PATTERNS = [/^\.env$/, /^\.env\./, /\.env$/];
const CONFIG_FILE_NAMES = [
  '.env',
  'docker-compose.yml',
  'docker-compose.yaml',
  'package.json',
];

function classifyFile(
  filename: string
): 'env' | 'docker-compose' | 'package-json' | 'config' | 'other' {
  const base = path.basename(filename);
  if (ENV_PATTERNS.some((p) => p.test(base))) return 'env';
  if (base === 'docker-compose.yml' || base === 'docker-compose.yaml') return 'docker-compose';
  if (base === 'package.json') return 'package-json';
  return 'other';
}

function isTargetFile(filename: string): boolean {
  const base = path.basename(filename);
  return (
    CONFIG_FILE_NAMES.includes(base) ||
    ENV_PATTERNS.some((p) => p.test(base))
  );
}

function scanDirectory(dirPath: string, depth: number, maxDepth: number): string[] {
  const found: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    // Skip hidden dirs at deeper levels (but .env files are targets, not dirs)
    if (entry.isDirectory()) {
      if (depth < maxDepth) {
        const subDir = path.join(dirPath, entry.name);
        found.push(...scanDirectory(subDir, depth + 1, maxDepth));
      }
    } else if (entry.isFile() && isTargetFile(entry.name)) {
      found.push(path.join(dirPath, entry.name));
    }
  }

  return found;
}

function discoverConfigFiles(): DiscoveredFile[] {
  const cwd = process.cwd();
  const filePaths = scanDirectory(cwd, 0, 3);

  return filePaths.map((filePath) => ({
    id: crypto.randomUUID(),
    path: filePath,
    type: classifyFile(filePath),
    allowed: 0 as const,
  }));
}

// ─── Priority mapping ─────────────────────────────────────────────────────────

function severityToPriority(severity: string | null): number {
  switch (severity) {
    case 'critical':
      return 1;
    case 'high':
      return 2;
    case 'medium':
      return 3;
    case 'low':
      return 4;
    default:
      return 4;
  }
}

// ─── Main scanner ─────────────────────────────────────────────────────────────

export async function runScan(): Promise<ScanResult> {
  const startTime = Date.now();

  // 1. Discover Docker containers
  const rawServices = await discoverDockerContainers();

  // 2. Discover config files
  const rawFiles = discoverConfigFiles();

  // 3. Filter through access rules
  const allowedServices = rawServices.filter((svc) => {
    const evalResult = evaluateAccess(svc.name, 'service');
    return evalResult.result === 'allow';
  });

  const allowedFiles = rawFiles
    .map((f) => {
      const evalResult = evaluateAccess(f.path, 'file');
      return { ...f, allowed: evalResult.result === 'allow' ? (1 as const) : (0 as const) };
    })
    .filter((f) => f.allowed === 1);

  // Steps 4–9 run inside a SQLite transaction
  let snapshotVersion = 0;
  let findingsProduced = 0;
  let tasksPromoted = 0;

  const txResult = db.transaction(() => {
    // 4. Compute new snapshot version
    const maxVersionRow = db.select({ maxVersion: max(graphSnapshots.version) }).from(graphSnapshots).get();
    const maxVersion = maxVersionRow?.maxVersion ?? 0;
    const version = (maxVersion ?? 0) + 1;
    snapshotVersion = version;

    // 5. Insert graph_snapshot
    const snapshotId = crypto.randomUUID();
    db.insert(graphSnapshots).values({
      id: snapshotId,
      version,
      graphData: JSON.stringify({
        services: allowedServices.map((s) => ({
          ...s,
          ports: s.ports,
          env_key_names: s.envKeyNames,
        })),
        files_configs: allowedFiles.map((f) => ({
          ...f,
        })),
      }),
      domains: '["services","files_configs"]',
    }).run();

    // Also insert service rows
    for (const svc of allowedServices) {
      db.insert(services).values({
        id: svc.id,
        name: svc.name,
        type: svc.type,
        status: svc.status,
        image: svc.image,
        ports: JSON.stringify(svc.ports),
        envKeyNames: JSON.stringify(svc.envKeyNames),
        snapshotId,
      }).run();
    }

    // Also insert file_config rows
    for (const f of allowedFiles) {
      db.insert(filesConfigs).values({
        id: f.id,
        path: f.path,
        type: f.type,
        allowed: f.allowed,
        snapshotId,
      }).run();
    }

    // 6. Insert graph_nodes
    for (const svc of allowedServices) {
      db.insert(graphNodes).values({
        id: crypto.randomUUID(),
        snapshotId,
        domain: 'services',
        nodeKey: `services:${svc.name}`,
        nodeData: JSON.stringify({
          name: svc.name,
          type: svc.type,
          status: svc.status,
          image: svc.image,
          ports: svc.ports,
          env_key_names: svc.envKeyNames,
        }),
      }).run();
    }

    for (const f of allowedFiles) {
      db.insert(graphNodes).values({
        id: crypto.randomUUID(),
        snapshotId,
        domain: 'files_configs',
        nodeKey: `files_configs:${f.path}`,
        nodeData: JSON.stringify({
          path: f.path,
          type: f.type,
          allowed: f.allowed,
        }),
      }).run();
    }

    // 7. Evaluate all enabled rules
    const enabledRules = db.select().from(rules).where(eq(rules.enabled, 1)).all();

    // Re-read snapshot graph_data for rule evaluation
    const snapshotRow = db.select().from(graphSnapshots).where(eq(graphSnapshots.id, snapshotId)).get();
    const graphData = snapshotRow ? JSON.parse(snapshotRow.graphData) : {};

    const insertedFindings: Array<{ id: string; ruleId: string; severity: string | null; title: string; detail: string }> = [];

    for (const rule of enabledRules) {
      let ruleResult: unknown;
      try {
        const script = new vm.Script(
          `(function(graphData) { ${rule.conditionSource} })(graphData)`
        );
        const context = vm.createContext({ graphData });
        ruleResult = script.runInContext(context, { timeout: 1000 });
      } catch (err) {
        console.warn(`[scanner] Rule "${rule.id}" evaluation error:`, String(err));
        continue;
      }

      if (!ruleResult) continue;

      // 7a. Insert finding (INSERT OR IGNORE via onConflictDoNothing)
      const findingId = crypto.randomUUID();
      const inserted = sqlite.prepare(`
        INSERT OR IGNORE INTO findings (id, rule_id, snapshot_id, severity, title, detail, recommended_action, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(findingId, rule.id, snapshotId, rule.severity, rule.name, rule.description, rule.recommendedAction);

      if (inserted.changes > 0) {
        findingsProduced++;
        insertedFindings.push({
          id: findingId,
          ruleId: rule.id,
          severity: rule.severity,
          title: rule.name,
          detail: rule.description,
        });
      }
    }

    // 8. Promote findings to tasks
    for (const finding of insertedFindings) {
      const matchedRule = enabledRules.find((r) => r.id === finding.ruleId);
      const taskInserted = sqlite.prepare(`
        INSERT OR IGNORE INTO tasks (id, finding_id, priority, title, context, reasoning, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        crypto.randomUUID(),
        finding.id,
        severityToPriority(finding.severity),
        finding.title,
        JSON.stringify({ snapshot_version: version, finding_detail: finding.detail }),
        `Rule "${matchedRule?.name ?? finding.ruleId}" fired on snapshot v${version}: ${finding.detail}`,
      );

      if (taskInserted.changes > 0) {
        tasksPromoted++;
      }
    }

    // 9. Append state_event
    db.insert(stateEvents).values({
      id: crypto.randomUUID(),
      eventType: 'scan.completed',
      domain: 'system',
      payload: JSON.stringify({
        snapshot_version: version,
        services_discovered: allowedServices.length,
        files_discovered: allowedFiles.length,
      }),
    }).run();

    // 10. Upsert state_snapshot
    const criticalFindings = insertedFindings.filter((f) => f.severity === 'critical').length;
    const totalFindings = insertedFindings.length;
    const scanAt = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO state_snapshots (id, snapshot_data, last_scan_at, service_count, finding_count, critical_count, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000001', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        snapshot_data = excluded.snapshot_data,
        last_scan_at = excluded.last_scan_at,
        service_count = excluded.service_count,
        finding_count = excluded.finding_count,
        critical_count = excluded.critical_count,
        updated_at = excluded.updated_at
    `).run(
      JSON.stringify({ snapshot_version: version }),
      scanAt,
      allowedServices.length,
      totalFindings,
      criticalFindings,
      scanAt,
    );

    return { version, findingsProduced, tasksPromoted };
  });

  snapshotVersion = txResult.version;
  findingsProduced = txResult.findingsProduced;
  tasksPromoted = txResult.tasksPromoted;

  return {
    snapshotVersion,
    servicesDiscovered: allowedServices.length,
    filesDiscovered: allowedFiles.length,
    findingsProduced,
    tasksPromoted,
    durationMs: Date.now() - startTime,
  };
}
