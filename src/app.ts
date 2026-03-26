import express, { Request, Response } from 'express';
import scanRouter from './routes/api/scan';
import servicesRouter from './routes/api/services';
import filesRouter from './routes/api/files';
import accessRouter from './routes/api/access';
import graphRouter from './routes/api/graph';
import rulesRouter from './routes/api/rules';
import findingsRouter from './routes/api/findings';

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
