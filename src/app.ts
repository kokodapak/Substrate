import express, { Request, Response } from 'express';
import path from 'path';
import scanRouter from './routes/api/scan';
import servicesRouter from './routes/api/services';
import filesRouter from './routes/api/files';
import accessRouter from './routes/api/access';
import graphRouter from './routes/api/graph';
import rulesRouter from './routes/api/rules';
import findingsRouter from './routes/api/findings';
import agentRouter from './routes/agent/tasks';
import stateRouter from './routes/api/state';

export const app = express();

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/scan', scanRouter);
app.use('/api/services', servicesRouter);
app.use('/api/files', filesRouter);
app.use('/api/access', accessRouter);
app.use('/api/graph', graphRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/findings', findingsRouter);
app.use('/agent', agentRouter);
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
