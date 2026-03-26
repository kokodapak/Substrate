import { Router } from 'express';
import { max, eq } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { graphSnapshots, filesConfigs } from '../../db/schema';

const router = Router();

router.get('/', requireAdmin, (_req, res) => {
  // Get the latest snapshot version
  const latestRow = db
    .select({ maxVersion: max(graphSnapshots.version) })
    .from(graphSnapshots)
    .get();

  const latestVersion = latestRow?.maxVersion ?? null;

  if (latestVersion === null) {
    return res.json({ snapshot_version: null, files: [] });
  }

  // Get the snapshot with the highest version
  const snapshot = db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.version, latestVersion))
    .get();

  if (!snapshot) {
    return res.json({ snapshot_version: null, files: [] });
  }

  // Get files for this snapshot
  const rows = db
    .select()
    .from(filesConfigs)
    .where(eq(filesConfigs.snapshotId, snapshot.id))
    .all();

  const result = rows.map((f) => ({
    id: f.id,
    path: f.path,
    type: f.type,
    allowed: f.allowed === 1,
    snapshot_id: f.snapshotId,
    discovered_at: f.discoveredAt,
  }));

  return res.json({ snapshot_version: latestVersion, files: result });
});

export default router;
