import { config } from '../config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// DATABASE_URL format: file:./data/substrate.db  OR  ./data/substrate.db
const dbPath = config.databaseUrl.startsWith('file:')
  ? config.databaseUrl.slice('file:'.length)
  : config.databaseUrl;

const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { sqlite };
