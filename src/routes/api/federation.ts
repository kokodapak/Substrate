import { Router } from 'express';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { satellites } from '../../db/schema';
import { encrypt } from '../../services/crypto';
import { syncSatellite } from '../../services/federation';

const router = Router();

// POST /api/federation/satellites — register a satellite
router.post('/federation/satellites', requireAdmin, (req, res) => {
  const { name, url, agent_key } = req.body as Record<string, unknown>;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'invalid_params', detail: 'name is required' });
  }

  if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({
      error: 'invalid_params',
      detail: 'url is required and must start with http:// or https://',
    });
  }

  if (!agent_key || typeof agent_key !== 'string' || agent_key.trim() === '') {
    return res.status(400).json({ error: 'invalid_params', detail: 'agent_key is required' });
  }

  const id = randomUUID();
  const agentKeyEncrypted = encrypt(agent_key);

  try {
    db.insert(satellites).values({
      id,
      name: name.trim(),
      url: url.trim(),
      agentKeyEncrypted,
      status: 'offline',
    }).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') || message.includes('unique')) {
      return res.status(409).json({ error: 'conflict', detail: 'A satellite with that name already exists' });
    }
    return res.status(500).json({ error: 'internal_server_error' });
  }

  const row = db.select().from(satellites).where(eq(satellites.id, id)).get();
  if (!row) {
    return res.status(500).json({ error: 'internal_server_error' });
  }

  return res.status(201).json({
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status,
    created_at: row.createdAt,
  });
});

// GET /api/federation/satellites — list satellites
router.get('/federation/satellites', requireAdmin, (_req, res) => {
  const rows = db.select().from(satellites).all();
  return res.json({
    satellites: rows.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      status: s.status,
      last_sync_at: s.lastSyncAt,
      created_at: s.createdAt,
    })),
  });
});

// DELETE /api/federation/satellites/:id — remove a satellite
router.delete('/federation/satellites/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const existing = db.select({ id: satellites.id }).from(satellites).where(eq(satellites.id, id)).get();
  if (!existing) {
    return res.status(404).json({ error: 'not_found' });
  }

  db.delete(satellites).where(eq(satellites.id, id)).run();
  return res.status(204).send();
});

// POST /api/federation/sync/:id — trigger immediate sync for one satellite
router.post('/federation/sync/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  const existing = db.select({ id: satellites.id }).from(satellites).where(eq(satellites.id, id)).get();
  if (!existing) {
    return res.status(404).json({ error: 'not_found' });
  }

  try {
    const result = await syncSatellite(id);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'sync_failed', code: 'sync_error', detail: message });
  }
});

export default router;
