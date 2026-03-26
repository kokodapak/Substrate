import { Router } from 'express';
import { desc, eq, gte, lte, and, sql } from 'drizzle-orm';
import { requireAdmin } from '../../middleware/auth';
import { db } from '../../db/index';
import { stateSnapshots, stateEvents } from '../../db/schema';

const router = Router();

// GET /api/state
router.get('/state', requireAdmin, (req, res) => {
  const snapshot = db
    .select()
    .from(stateSnapshots)
    .where(eq(stateSnapshots.id, '00000000-0000-0000-0000-000000000001'))
    .get();

  if (!snapshot) {
    return res.status(404).json({ error: 'no_state' });
  }

  const recentRows = db
    .select()
    .from(stateEvents)
    .orderBy(desc(stateEvents.occurredAt))
    .limit(50)
    .all();

  const recentEvents = recentRows.map((e) => ({
    id: e.id,
    event_type: e.eventType,
    domain: e.domain,
    payload: (() => {
      try {
        return JSON.parse(e.payload) as unknown;
      } catch {
        return e.payload;
      }
    })(),
    occurred_at: e.occurredAt,
  }));

  return res.json({
    current: {
      service_count: snapshot.serviceCount ?? 0,
      finding_count: snapshot.findingCount ?? 0,
      critical_count: snapshot.criticalCount ?? 0,
      last_scan_at: snapshot.lastScanAt,
    },
    recent_events: recentEvents,
  });
});

// GET /api/timeline
router.get('/timeline', requireAdmin, (req, res) => {
  const domainFilter = req.query['domain'] as string | undefined;
  const eventTypeFilter = req.query['event_type'] as string | undefined;
  const sinceParam = req.query['since'] as string | undefined;
  const untilParam = req.query['until'] as string | undefined;
  const limitParam = req.query['limit'] as string | undefined;
  const offsetParam = req.query['offset'] as string | undefined;

  // Parse and validate limit
  let limit = 50;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return res.status(400).json({
        error: 'invalid_params',
        detail: 'limit must be a positive integer',
      });
    }
    limit = Math.min(parsed, 200);
  }

  // Parse and validate offset
  let offset = 0;
  if (offsetParam !== undefined) {
    const parsed = Number(offsetParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({
        error: 'invalid_params',
        detail: 'offset must be a non-negative integer',
      });
    }
    offset = parsed;
  }

  // Build WHERE conditions
  type EventCondition = Parameters<typeof and>[0];
  const conditions: EventCondition[] = [];

  if (domainFilter !== undefined) {
    conditions.push(eq(stateEvents.domain, domainFilter));
  }

  if (eventTypeFilter !== undefined) {
    conditions.push(eq(stateEvents.eventType, eventTypeFilter));
  }

  if (sinceParam !== undefined) {
    conditions.push(gte(stateEvents.occurredAt, sinceParam));
  }

  if (untilParam !== undefined) {
    conditions.push(lte(stateEvents.occurredAt, untilParam));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // COUNT total
  const countRow = db
    .select({ count: sql<number>`count(*)` })
    .from(stateEvents)
    .where(whereClause)
    .get();

  const total = countRow?.count ?? 0;

  // SELECT with pagination
  const rows = db
    .select()
    .from(stateEvents)
    .where(whereClause)
    .orderBy(desc(stateEvents.occurredAt))
    .limit(limit)
    .offset(offset)
    .all();

  const events = rows.map((e) => ({
    id: e.id,
    event_type: e.eventType,
    domain: e.domain,
    payload: (() => {
      try {
        return JSON.parse(e.payload) as unknown;
      } catch {
        return e.payload;
      }
    })(),
    occurred_at: e.occurredAt,
  }));

  return res.json({ events, total, limit, offset });
});

export default router;
