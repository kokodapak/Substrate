import * as fs from 'fs';
import * as path from 'path';

export interface PluginRuleDescriptor {
  id: string;
  name: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  condition_source: string;
  recommended_action: string;
  source_path: string;
  loaded: boolean;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;

// In-memory list of all discovered plugin descriptors (loaded or not).
// Exported so the /api/rules/plugins endpoint can read it without re-scanning disk.
export let pluginDescriptors: PluginRuleDescriptor[] = [];

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && KEBAB_CASE_RE.test(id);
}

function isValidSeverity(sev: unknown): sev is PluginRuleDescriptor['severity'] {
  return typeof sev === 'string' && VALID_SEVERITIES.has(sev);
}

function validateRule(obj: unknown): obj is Omit<PluginRuleDescriptor, 'source_path' | 'loaded'> {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    isValidId(r['id']) &&
    typeof r['name'] === 'string' && r['name'].length > 0 &&
    typeof r['description'] === 'string' && r['description'].length > 0 &&
    isValidSeverity(r['severity']) &&
    typeof r['condition_source'] === 'string' && r['condition_source'].length > 0 &&
    typeof r['recommended_action'] === 'string' && r['recommended_action'].length > 0
  );
}

export function loadPluginRules(pluginsDir: string): PluginRuleDescriptor[] {
  const results: PluginRuleDescriptor[] = [];

  if (!fs.existsSync(pluginsDir)) {
    pluginDescriptors = results;
    return results;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(pluginsDir);
  } catch (err) {
    console.warn(`[plugin-loader] Could not read plugins directory ${pluginsDir}: ${String(err)}`);
    pluginDescriptors = results;
    return results;
  }

  const jsFiles = entries.filter(
    (e) => e.endsWith('.js') && fs.statSync(path.join(pluginsDir, e)).isFile()
  );

  for (const file of jsFiles) {
    const filePath = path.resolve(pluginsDir, file);
    let exported: unknown;

    try {
      // Clear require cache so tests can reload different plugin files
      delete require.cache[require.resolve(filePath)];
      exported = require(filePath);
    } catch (err) {
      console.warn(`[plugin-loader] Failed to require plugin file ${filePath}: ${String(err)}`);
      results.push({
        id: file.replace(/\.js$/, ''),
        name: file,
        description: '',
        severity: 'low',
        condition_source: '',
        recommended_action: '',
        source_path: filePath,
        loaded: false,
      });
      continue;
    }

    if (!Array.isArray(exported)) {
      console.warn(`[plugin-loader] Plugin file ${filePath} does not export an array — skipping`);
      results.push({
        id: file.replace(/\.js$/, ''),
        name: file,
        description: '',
        severity: 'low',
        condition_source: '',
        recommended_action: '',
        source_path: filePath,
        loaded: false,
      });
      continue;
    }

    for (const item of exported) {
      if (!validateRule(item)) {
        console.warn(`[plugin-loader] Invalid rule in ${filePath}: ${JSON.stringify(item)}`);
        results.push({
          id: typeof (item as Record<string, unknown>)?.['id'] === 'string'
            ? (item as Record<string, unknown>)['id'] as string
            : file.replace(/\.js$/, ''),
          name: file,
          description: '',
          severity: 'low',
          condition_source: '',
          recommended_action: '',
          source_path: filePath,
          loaded: false,
        });
        continue;
      }

      const rule = item as Record<string, unknown>;
      results.push({
        id: rule['id'] as string,
        name: rule['name'] as string,
        description: rule['description'] as string,
        severity: rule['severity'] as PluginRuleDescriptor['severity'],
        condition_source: rule['condition_source'] as string,
        recommended_action: rule['recommended_action'] as string,
        source_path: filePath,
        loaded: true,
      });
    }
  }

  pluginDescriptors = results;
  return results;
}

export function getPluginsDir(): string {
  return process.env['SUBSTRATE_PLUGINS_DIR']
    ? path.resolve(process.env['SUBSTRATE_PLUGINS_DIR'])
    : path.join(process.cwd(), 'plugins', 'rules');
}
