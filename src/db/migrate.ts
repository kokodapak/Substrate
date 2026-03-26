import '../config'; // Ensure env is validated first
import path from 'path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './index';
import { loadPluginRules, getPluginsDir } from '../services/plugin-loader';

export function runMigrations(): void {
  migrate(db, { migrationsFolder: path.join(__dirname, '..', '..', 'migrations') });
  seedBuiltInRules();
}

export function loadAndRegisterPluginRules(): void {
  const pluginsDir = getPluginsDir();
  const descriptors = loadPluginRules(pluginsDir);

  if (descriptors.length === 0) return;

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO rules (id, name, description, severity, condition_source, recommended_action, built_in)
    VALUES (@id, @name, @description, @severity, @conditionSource, @recommendedAction, 0)
  `);

  const insertMany = sqlite.transaction(
    (rows: Array<{ id: string; name: string; description: string; severity: string; conditionSource: string; recommendedAction: string }>) => {
      for (const row of rows) {
        insert.run(row);
      }
    }
  );

  const loadedRules = descriptors
    .filter((d) => d.loaded)
    .map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      severity: d.severity,
      conditionSource: d.condition_source,
      recommendedAction: d.recommended_action,
    }));

  if (loadedRules.length > 0) {
    insertMany(loadedRules);
    console.log(`[plugin-loader] Registered ${loadedRules.length} plugin rule(s)`);
  }
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
}

// Main
runMigrations();
