import { Router } from 'express';
import { eq, max } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { graphSnapshots, graphNodes, graphEdges } from '../../db/schema';

const router = Router();

// GET /api/graph — returns the latest graph snapshot
router.get('/', requireAdmin, (_req, res) => {
  const latestRow = db
    .select({ maxVersion: max(graphSnapshots.version) })
    .from(graphSnapshots)
    .get();

  const latestVersion = latestRow?.maxVersion ?? null;

  if (latestVersion === null) {
    return res.status(404).json({ error: 'no_snapshot' });
  }

  const snapshot = db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.version, latestVersion))
    .get();

  if (!snapshot) {
    return res.status(404).json({ error: 'no_snapshot' });
  }

  const edgeRows = db
    .select()
    .from(graphEdges)
    .where(eq(graphEdges.snapshotId, snapshot.id))
    .all();

  const edges = edgeRows.map((e) => ({
    id: e.id,
    snapshot_id: e.snapshotId,
    from_node_key: e.fromNodeKey,
    to_node_key: e.toNodeKey,
    edge_type: e.edgeType,
    metadata: e.metadata ?? null,
    created_at: e.createdAt,
  }));

  const graphData = JSON.parse(snapshot.graphData) as Record<string, unknown>;
  graphData['edges'] = edges;

  return res.json({
    version: snapshot.version,
    created_at: snapshot.createdAt,
    domains: JSON.parse(snapshot.domains ?? '["services","files_configs"]') as string[],
    graph_data: graphData,
  });
});

// GET /api/graph/diff — compute a structured diff between two snapshot versions
router.get('/diff', requireAdmin, (req, res) => {
  const fromParam = req.query['from'];
  const toParam = req.query['to'];

  // Validate `from`
  if (fromParam === undefined || fromParam === null || fromParam === '') {
    return res.status(400).json({ error: 'invalid_params', detail: '`from` is required' });
  }

  const fromNum = Number(fromParam);
  if (!Number.isInteger(fromNum) || fromNum < 0) {
    return res.status(400).json({ error: 'invalid_params', detail: '`from` must be a non-negative integer' });
  }

  // Validate `to` if provided
  let toNum: number;
  if (toParam !== undefined && toParam !== null && toParam !== '') {
    const parsed = Number(toParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({ error: 'invalid_params', detail: '`to` must be a non-negative integer' });
    }
    toNum = parsed;
  } else {
    // Default to latest version
    const latestRow = db
      .select({ maxVersion: max(graphSnapshots.version) })
      .from(graphSnapshots)
      .get();

    const latestVersion = latestRow?.maxVersion ?? null;
    if (latestVersion === null) {
      return res.status(404).json({ error: 'snapshot_not_found', version: fromNum });
    }
    toNum = latestVersion;
  }

  // Verify both snapshots exist before checking ordering
  const fromSnapshot = db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.version, fromNum))
    .get();

  if (!fromSnapshot) {
    return res.status(404).json({ error: 'snapshot_not_found', version: fromNum });
  }

  const toSnapshot = db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.version, toNum))
    .get();

  if (!toSnapshot) {
    return res.status(404).json({ error: 'snapshot_not_found', version: toNum });
  }

  // Validate from < to
  if (fromNum >= toNum) {
    return res.status(400).json({ error: 'invalid_params', detail: '`from` must be less than `to`' });
  }

  // Load nodes for both snapshots
  const fromNodes = db
    .select()
    .from(graphNodes)
    .where(eq(graphNodes.snapshotId, fromSnapshot.id))
    .all();

  const toNodes = db
    .select()
    .from(graphNodes)
    .where(eq(graphNodes.snapshotId, toSnapshot.id))
    .all();

  // Build maps: domain -> (nodeKey -> nodeData)
  type NodeMap = Map<string, object>;
  const fromByDomain = new Map<string, NodeMap>();
  const toByDomain = new Map<string, NodeMap>();

  for (const node of fromNodes) {
    if (!fromByDomain.has(node.domain)) fromByDomain.set(node.domain, new Map());
    fromByDomain.get(node.domain)!.set(node.nodeKey, JSON.parse(node.nodeData) as object);
  }

  for (const node of toNodes) {
    if (!toByDomain.has(node.domain)) toByDomain.set(node.domain, new Map());
    toByDomain.get(node.domain)!.set(node.nodeKey, JSON.parse(node.nodeData) as object);
  }

  // Get all distinct domains from both snapshots
  const allDomains = new Set<string>([...fromByDomain.keys(), ...toByDomain.keys()]);

  // Helper: strip comparison-excluded fields from a node data object
  function stripExcludedFields(obj: object): object {
    const result = { ...obj } as Record<string, unknown>;
    delete result['id'];
    delete result['snapshot_id'];
    delete result['discovered_at'];
    return result;
  }

  const domains: Record<
    string,
    {
      added: string[];
      removed: string[];
      modified: Array<{ node_key: string; before: object; after: object }>;
    }
  > = {};

  for (const domain of allDomains) {
    const fromMap: NodeMap = fromByDomain.get(domain) ?? new Map();
    const toMap: NodeMap = toByDomain.get(domain) ?? new Map();

    const added: string[] = [];
    const removed: string[] = [];
    const modified: Array<{ node_key: string; before: object; after: object }> = [];

    // Keys in `to` but not in `from` → added
    for (const key of toMap.keys()) {
      if (!fromMap.has(key)) {
        added.push(key);
      }
    }

    // Keys in `from` but not in `to` → removed
    for (const key of fromMap.keys()) {
      if (!toMap.has(key)) {
        removed.push(key);
      }
    }

    // Keys in both → check for modification
    for (const key of fromMap.keys()) {
      if (toMap.has(key)) {
        const beforeData = stripExcludedFields(fromMap.get(key)!);
        const afterData = stripExcludedFields(toMap.get(key)!);
        if (JSON.stringify(beforeData) !== JSON.stringify(afterData)) {
          modified.push({ node_key: key, before: beforeData, after: afterData });
        }
      }
    }

    domains[domain] = { added, removed, modified };
  }

  // Load edges for both snapshots
  const fromEdges = db
    .select()
    .from(graphEdges)
    .where(eq(graphEdges.snapshotId, fromSnapshot.id))
    .all();

  const toEdges = db
    .select()
    .from(graphEdges)
    .where(eq(graphEdges.snapshotId, toSnapshot.id))
    .all();

  // Stable edge key: (fromNodeKey, toNodeKey, edgeType)
  function edgeKey(e: { fromNodeKey: string | null; toNodeKey: string | null; edgeType: string | null }): string {
    return `${e.fromNodeKey ?? ''}|${e.toNodeKey ?? ''}|${e.edgeType ?? ''}`;
  }

  const fromEdgeMap = new Map(fromEdges.map((e) => [edgeKey(e), e]));
  const toEdgeMap = new Map(toEdges.map((e) => [edgeKey(e), e]));

  function toSnakeCase(e: typeof fromEdges[number]) {
    return {
      id: e.id,
      snapshot_id: e.snapshotId,
      from_node_key: e.fromNodeKey,
      to_node_key: e.toNodeKey,
      edge_type: e.edgeType,
      metadata: e.metadata ?? null,
      created_at: e.createdAt,
    };
  }

  const edge_additions = toEdges.filter((e) => !fromEdgeMap.has(edgeKey(e))).map(toSnakeCase);
  const edge_removals = fromEdges.filter((e) => !toEdgeMap.has(edgeKey(e))).map(toSnakeCase);

  return res.json({ from: fromNum, to: toNum, domains, edge_additions, edge_removals });
});

export default router;
