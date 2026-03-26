import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  driver: 'better-sqlite',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'file:./data/substrate.db',
  },
} satisfies Config;
