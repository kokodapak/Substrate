import { sqliteTable, text, integer, unique } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── graph_snapshots ───────────────────────────────────────────────────────────
export const graphSnapshots = sqliteTable('graph_snapshots', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  graphData: text('graph_data').notNull(),
  domains: text('domains').default('["services","files_configs"]'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// ─── services ─────────────────────────────────────────────────────────────────
export const services = sqliteTable('services', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['container', 'process', 'app'] }),
  status: text('status', { enum: ['running', 'stopped', 'exited', 'unknown'] }),
  image: text('image'),
  ports: text('ports').default('[]'),
  envKeyNames: text('env_key_names').default('[]'),
  snapshotId: text('snapshot_id').references(() => graphSnapshots.id),
  discoveredAt: text('discovered_at').default(sql`(datetime('now'))`),
});

// ─── files_configs ────────────────────────────────────────────────────────────
export const filesConfigs = sqliteTable('files_configs', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
  type: text('type', { enum: ['env', 'docker-compose', 'package-json', 'config', 'other'] }),
  allowed: integer('allowed').default(0),
  snapshotId: text('snapshot_id').references(() => graphSnapshots.id),
  discoveredAt: text('discovered_at').default(sql`(datetime('now'))`),
});

// ─── graph_nodes ──────────────────────────────────────────────────────────────
export const graphNodes = sqliteTable(
  'graph_nodes',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id').references(() => graphSnapshots.id),
    domain: text('domain').notNull(),
    nodeKey: text('node_key').notNull(),
    nodeData: text('node_data').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
  },
  (t) => ({
    uniqSnapshotNodeKey: unique().on(t.snapshotId, t.nodeKey),
  })
);

// ─── rules ────────────────────────────────────────────────────────────────────
export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(), // kebab-case
  name: text('name').notNull(),
  description: text('description').notNull(),
  severity: text('severity', { enum: ['critical', 'high', 'medium', 'low'] }),
  enabled: integer('enabled').default(1),
  conditionSource: text('condition_source').notNull(),
  recommendedAction: text('recommended_action').notNull(),
  builtIn: integer('built_in').default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ─── findings ─────────────────────────────────────────────────────────────────
export const findings = sqliteTable(
  'findings',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id').references(() => rules.id),
    snapshotId: text('snapshot_id').references(() => graphSnapshots.id),
    severity: text('severity', { enum: ['critical', 'high', 'medium', 'low'] }),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    recommendedAction: text('recommended_action').notNull(),
    status: text('status', { enum: ['open', 'acknowledged', 'resolved'] }).default('open'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (t) => ({
    uniqRuleSnapshot: unique().on(t.ruleId, t.snapshotId),
  })
);

// ─── tasks ────────────────────────────────────────────────────────────────────
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    findingId: text('finding_id').references(() => findings.id),
    priority: integer('priority').notNull(),
    title: text('title').notNull(),
    context: text('context').notNull(),
    reasoning: text('reasoning').notNull(),
    status: text('status', {
      enum: ['pending', 'claimed', 'done', 'skipped'],
    }).default('pending'),
    claimedBy: text('claimed_by'),
    claimedAt: text('claimed_at'),
    lockExpiresAt: text('lock_expires_at'),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  },
  (t) => ({
    uniqFinding: unique().on(t.findingId),
  })
);

// ─── state_events ─────────────────────────────────────────────────────────────
// Append-only — never UPDATE or DELETE rows
export const stateEvents = sqliteTable('state_events', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  domain: text('domain').notNull(),
  payload: text('payload').notNull(),
  occurredAt: text('occurred_at').default(sql`(datetime('now'))`),
});

// ─── state_snapshots ──────────────────────────────────────────────────────────
export const stateSnapshots = sqliteTable('state_snapshots', {
  id: text('id').primaryKey().default('00000000-0000-0000-0000-000000000001'),
  snapshotData: text('snapshot_data').notNull(),
  lastScanAt: text('last_scan_at').notNull(),
  serviceCount: integer('service_count').default(0),
  findingCount: integer('finding_count').default(0),
  criticalCount: integer('critical_count').default(0),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ─── agent_actions ────────────────────────────────────────────────────────────
export const agentActions = sqliteTable('agent_actions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasks.id),
  agentId: text('agent_id').notNull(),
  actionType: text('action_type', {
    enum: ['restart_container', 'write_file', 'exec_command', 'http_request', 'custom'],
  }).notNull(),
  target: text('target').notNull(),
  payload: text('payload'),
  outcome: text('outcome', { enum: ['success', 'failure', 'partial'] }).notNull(),
  notes: text('notes'),
  occurredAt: text('occurred_at').default(sql`(datetime('now'))`),
});

// ─── graph_edges ──────────────────────────────────────────────────────────────
export const graphEdges = sqliteTable('graph_edges', {
  id: text('id').primaryKey(),
  snapshotId: text('snapshot_id').references(() => graphSnapshots.id),
  fromNodeKey: text('from_node_key').notNull(),
  toNodeKey: text('to_node_key').notNull(),
  edgeType: text('edge_type', {
    enum: ['depends_on', 'exposes_port', 'mounts_volume', 'reads_env_file'],
  }).notNull(),
  metadata: text('metadata'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// ─── access_rules ─────────────────────────────────────────────────────────────
export const accessRules = sqliteTable(
  'access_rules',
  {
    id: text('id').primaryKey(),
    source: text('source', { enum: ['botignore', 'botinclude'] }),
    pattern: text('pattern').notNull(),
    domain: text('domain', { enum: ['file', 'service', 'env', 'integration', 'any'] }).default(
      'any'
    ),
    action: text('action', { enum: ['deny', 'allow'] }),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
  },
  (t) => ({
    uniqSourcePatternDomain: unique().on(t.source, t.pattern, t.domain),
  })
);
