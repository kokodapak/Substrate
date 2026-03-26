import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * Compare two strings using a timing-safe comparison.
 * Returns false if lengths differ (without leaking length info via timing).
 */
function safeCompare(a: string, b: string): boolean {
  // Buffers must be equal length for timingSafeEqual — pad to the longer length.
  // We still return false if lengths differ to enforce exact match.
  if (a.length !== b.length) {
    // Still run a dummy comparison to avoid timing differences between
    // "wrong length" and "wrong content" branches.
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    const dummy = Buffer.alloc(Math.max(bufA.length, bufB.length));
    timingSafeEqual(dummy, dummy); // no-op comparison
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

/**
 * requireAdmin — validates X-Api-Key === SUBSTRATE_ADMIN_KEY.
 * Returns 401 if missing/wrong, 403 if the agent key is presented on an admin route.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];

  if (!key || typeof key !== 'string') {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Check if it's the agent key (forbidden on admin routes)
  if (safeCompare(key, config.agentKey)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (!safeCompare(key, config.adminKey)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  req.role = 'admin';
  next();
}

/**
 * requireAgent — validates X-Api-Key matches either SUBSTRATE_ADMIN_KEY or SUBSTRATE_AGENT_KEY.
 * Returns 401 if missing/wrong.
 */
export function requireAgent(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];

  if (!key || typeof key !== 'string') {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const isAdmin = safeCompare(key, config.adminKey);
  const isAgent = safeCompare(key, config.agentKey);

  if (!isAdmin && !isAgent) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  req.role = isAdmin ? 'admin' : 'agent';
  next();
}

/**
 * requireAgentId — validates X-Agent-Id header.
 * Must be present, non-empty, and at most 128 characters.
 * Attaches req.agentId on success.
 */
export function requireAgentId(req: Request, res: Response, next: NextFunction): void {
  const agentId = req.headers['x-agent-id'];

  if (!agentId || typeof agentId !== 'string' || agentId.trim() === '' || agentId.length > 128) {
    res.status(400).json({ error: 'missing_agent_id' });
    return;
  }

  req.agentId = agentId;
  next();
}
