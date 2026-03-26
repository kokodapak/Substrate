import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { satellites, graphSnapshots, findings, stateEvents } from '../db/schema';
import { decrypt } from './crypto';

export interface SyncResult {
  synced_snapshots: number;
  synced_findings: number;
  synced_tasks: number;
  duration_ms: number;
}

export async function syncSatellite(satelliteId: string): Promise<SyncResult> {
  const start = Date.now();

  const satellite = db
    .select()
    .from(satellites)
    .where(eq(satellites.id, satelliteId))
    .get();

  if (!satellite) {
    throw new Error(`Satellite not found: ${satelliteId}`);
  }

  const agentKey = decrypt(satellite.agentKeyEncrypted);
  const headers = { 'X-Api-Key': agentKey };

  async function fetchJson(path: string): Promise<unknown> {
    const url = `${satellite!.url}${path}`;
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.update(satellites).set({ status: 'error' }).where(eq(satellites.id, satelliteId)).run();
      db.insert(stateEvents).values({
        id: randomUUID(),
        eventType: 'satellite.sync.failed',
        domain: 'federation',
        payload: JSON.stringify({ satellite_id: satelliteId, error: message }),
      }).run();
      throw new Error(`Network error fetching ${url}: ${message}`);
    }
    if (!response.ok) {
      const detail = `HTTP ${response.status} from ${url}`;
      db.update(satellites).set({ status: 'error' }).where(eq(satellites.id, satelliteId)).run();
      db.insert(stateEvents).values({
        id: randomUUID(),
        eventType: 'satellite.sync.failed',
        domain: 'federation',
        payload: JSON.stringify({ satellite_id: satelliteId, error: detail }),
      }).run();
      throw new Error(detail);
    }
    return response.json() as Promise<unknown>;
  }

  const [graphData, findingsData, stateData] = await Promise.all([
    fetchJson('/api/graph'),
    fetchJson('/api/findings'),
    fetchJson('/api/state'),
  ]);

  let syncedSnapshots = 0;
  let syncedFindings = 0;
  const syncedTasks = 0;

  db.transaction(() => {
    const graph = graphData as Record<string, unknown>;
    const snapshotId = randomUUID();
    const graphVersion = typeof graph['version'] === 'number' ? graph['version'] : 0;
    const graphCreatedAt = typeof graph['created_at'] === 'string' ? graph['created_at'] : undefined;

    // Deduplicate by (satellite_id, satellite version): if we already have this version, skip
    const alreadyHasSnapshot = db
      .select({ id: graphSnapshots.id })
      .from(graphSnapshots)
      .where(eq(graphSnapshots.satelliteId, satelliteId))
      .all()
      .some((row) => {
        // Compare version stored against satellite's reported version
        const stored = db
          .select({ version: graphSnapshots.version })
          .from(graphSnapshots)
          .where(eq(graphSnapshots.id, row.id))
          .get();
        return stored?.version === graphVersion;
      });

    if (!alreadyHasSnapshot) {
      try {
        db.insert(graphSnapshots).values({
          id: snapshotId,
          version: graphVersion,
          graphData: JSON.stringify(graph['graph_data'] ?? {}),
          domains: JSON.stringify(graph['domains'] ?? ['services', 'files_configs']),
          createdAt: graphCreatedAt,
          satelliteId,
        }).run();
        syncedSnapshots = 1;
      } catch {
        // Skip on constraint error
      }
    }

    // Insert findings — always with new UUIDs, tagged to this satellite
    const findingsPayload = findingsData as Record<string, unknown>;
    const findingRows = Array.isArray(findingsPayload['findings'])
      ? (findingsPayload['findings'] as Record<string, unknown>[])
      : [];

    for (const f of findingRows) {
      try {
        db.insert(findings).values({
          id: randomUUID(),
          ruleId: typeof f['rule_id'] === 'string' ? f['rule_id'] : null,
          snapshotId,
          severity: (f['severity'] as 'critical' | 'high' | 'medium' | 'low') ?? null,
          title: typeof f['title'] === 'string' ? f['title'] : '',
          detail: typeof f['detail'] === 'string' ? f['detail'] : '',
          recommendedAction:
            typeof f['recommended_action'] === 'string' ? f['recommended_action'] : '',
          status: (f['status'] as 'open' | 'acknowledged' | 'resolved') ?? 'open',
          satelliteId,
        }).run();
        syncedFindings++;
      } catch {
        // Skip on constraint error
      }
    }

    // Insert state events from satellite
    const statePayload = stateData as Record<string, unknown>;
    const eventRows = Array.isArray(statePayload['recent_events'])
      ? (statePayload['recent_events'] as Record<string, unknown>[])
      : [];

    for (const e of eventRows) {
      try {
        db.insert(stateEvents).values({
          id: randomUUID(),
          eventType: typeof e['event_type'] === 'string' ? e['event_type'] : 'unknown',
          domain: typeof e['domain'] === 'string' ? e['domain'] : 'unknown',
          payload:
            typeof e['payload'] === 'string'
              ? e['payload']
              : JSON.stringify(e['payload'] ?? {}),
          occurredAt: typeof e['occurred_at'] === 'string' ? e['occurred_at'] : undefined,
          satelliteId,
        }).run();
      } catch {
        // Skip on constraint error
      }
    }

    // Update satellite status and last_sync_at
    db.update(satellites)
      .set({
        status: 'online',
        lastSyncAt: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
      })
      .where(eq(satellites.id, satelliteId))
      .run();
  });

  return {
    synced_snapshots: syncedSnapshots,
    synced_findings: syncedFindings,
    synced_tasks: syncedTasks,
    duration_ms: Date.now() - start,
  };
}

export function startFederationSync(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const allSatellites = db.select({ id: satellites.id }).from(satellites).all();
    for (const s of allSatellites) {
      syncSatellite(s.id).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Federation sync failed for satellite ${s.id}: ${message}`);
      });
    }
  }, 60_000);
}

export function stopFederationSync(id: ReturnType<typeof setInterval>): void {
  clearInterval(id);
}
