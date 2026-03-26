import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import scanRouter from './routes/api/scan';
import servicesRouter from './routes/api/services';
import filesRouter from './routes/api/files';
import accessRouter from './routes/api/access';
import graphRouter from './routes/api/graph';
import rulesRouter from './routes/api/rules';
import findingsRouter from './routes/api/findings';
import agentRouter from './routes/agent/tasks';
import agentActionsRouter from './routes/agent/actions';
import streamRouter from './routes/agent/stream';
import apiActionsRouter from './routes/api/actions';
import stateRouter from './routes/api/state';
import { requestLogger } from './middleware/request-logger';
import { sqlite } from './db/index';
import { config } from './config';

export const app = express();

// Request logger — must be first middleware
app.use(requestLogger);

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  let dbStatus: 'ok' | 'error' = 'ok';
  try {
    sqlite.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }

  res.status(200).json({
    status: 'ok',
    version: '0.1.0',
    uptime_s: Math.floor(process.uptime()),
    db: dbStatus,
  });
});

app.use('/api/scan', scanRouter);
app.use('/api/services', servicesRouter);
app.use('/api/files', filesRouter);
app.use('/api/access', accessRouter);
app.use('/api/graph', graphRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/findings', findingsRouter);
app.use('/agent', agentRouter);
app.use('/agent', agentActionsRouter);
app.use('/agent', streamRouter);
app.use('/api', apiActionsRouter);
app.use('/api', stateRouter);

// Serve built React SPA for all non-API routes
app.use(express.static(path.join(__dirname, '../dist/public')));
app.get('*', (req: Request, res: Response) => {
  if (
    !req.path.startsWith('/api') &&
    !req.path.startsWith('/agent') &&
    !req.path.startsWith('/health')
  ) {
    res.sendFile(path.join(__dirname, '../dist/public/index.html'));
  }
});

// Global error handler — must be last middleware
// Captures unhandled errors, sends to Sentry if configured, returns generic 500
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (config.sentryDsn) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Sentry = require('@sentry/node') as { captureException: (e: Error) => void };
      Sentry.captureException(err);
    } catch {
      // Ignore Sentry errors — never let error reporting break error handling
    }
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'internal_server_error' });
});
