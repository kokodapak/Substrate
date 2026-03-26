import { Router } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { RateLimiter } from '../../services/rate-limiter';
import { runScan } from '../../services/scanner';

const router = Router();
const scanRateLimiter = new RateLimiter(10_000, 1);

router.post('/', requireAdmin, async (req, res) => {
  const limit = scanRateLimiter.check('scan');
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limit_exceeded', retry_after_ms: limit.retryAfterMs });
  }
  try {
    const result = await runScan();
    return res.json({
      snapshot_version: result.snapshotVersion,
      services_discovered: result.servicesDiscovered,
      files_discovered: result.filesDiscovered,
      findings_produced: result.findingsProduced,
      tasks_promoted: result.tasksPromoted,
      duration_ms: result.durationMs,
    });
  } catch (err) {
    return res.status(500).json({ error: 'scan_failed', detail: String(err) });
  }
});

export default router;
