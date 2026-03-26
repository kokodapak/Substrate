import { Router, Request, Response } from 'express';
import { requireAgent, requireAgentId, requireAdmin } from '../../middleware/auth';
import { sseBroadcaster } from '../../services/sse-broadcaster';

const router = Router();

// ─── GET /agent/stream ────────────────────────────────────────────────────────

router.get('/stream', requireAgent, requireAgentId, (req: Request, res: Response): void => {
  const agentId = req.agentId!;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseBroadcaster.addClient(agentId, res);

  res.write(`event: connected\ndata: ${JSON.stringify({ agent_id: agentId, timestamp: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseBroadcaster.removeClient(agentId);
  });
});

// ─── GET /agent/stream/status ─────────────────────────────────────────────────

router.get('/stream/status', requireAdmin, (_req: Request, res: Response): void => {
  res.status(200).json({
    connected_agents: sseBroadcaster.getConnectedAgents(),
    connection_count: sseBroadcaster.getConnectionCount(),
  });
});

export default router;
