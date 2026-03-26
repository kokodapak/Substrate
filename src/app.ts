import express, { Request, Response } from 'express';
import scanRouter from './routes/api/scan';
import servicesRouter from './routes/api/services';
import filesRouter from './routes/api/files';
import accessRouter from './routes/api/access';

export const app = express();

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/scan', scanRouter);
app.use('/api/services', servicesRouter);
app.use('/api/files', filesRouter);
app.use('/api/access', accessRouter);
