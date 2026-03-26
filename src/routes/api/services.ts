import { Router } from 'express';
import { desc, max } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { graphSnapshots, services } from '../../db/schema';
import { eq } from 'drizzle-orm';

const router = Router();

router.get('/', requireAdmin, (_req, res) => {
  // Get the latest snapshot version
  const latestRow = db
    .select({ maxVersion: max(graphSnapshots.version) })
    .from(graphSnapshots)
    .get();

  const latestVersion = latestRow?.maxVersion ?? null;

  if (latestVersion === null) {
    return res.json({ snapshot_version: null, services: [] });
  }

  // Get the snapshot with the highest version
  const snapshot = db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.version, latestVersion))
    .get();

  if (!snapshot) {
    return res.json({ snapshot_version: null, services: [] });
  }

  // Get services for this snapshot
  const rows = db
    .select()
    .from(services)
    .where(eq(services.snapshotId, snapshot.id))
    .all();

  const result = rows.map((svc) => ({
    id: svc.id,
    name: svc.name,
    type: svc.type,
    status: svc.status,
    image: svc.image,
    ports: JSON.parse(svc.ports ?? '[]') as unknown[],
    env_key_names: JSON.parse(svc.envKeyNames ?? '[]') as string[],
    snapshot_id: svc.snapshotId,
    discovered_at: svc.discoveredAt,
  }));

  return res.json({ snapshot_version: latestVersion, services: result });
});

export default router;
