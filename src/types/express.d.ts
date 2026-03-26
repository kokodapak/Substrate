import 'express';

declare module 'express' {
  interface Request {
    role?: 'admin' | 'agent';
    agentId?: string;
  }
}
