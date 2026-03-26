import { Request, Response, NextFunction } from 'express';

/**
 * Request logger middleware.
 * Logs: METHOD PATH STATUS DURATIONms
 * Format: [2026-03-26T19:00:00Z] GET /api/graph 200 12ms
 * No PII, no request bodies, no auth headers.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const timestamp = new Date().toISOString();
    process.stdout.write(`[${timestamp}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms\n`);
  });

  next();
}
