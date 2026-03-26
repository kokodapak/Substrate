/**
 * Vitest global setup — sets env vars before any test file is loaded.
 * This must run before config.ts is imported anywhere.
 */
process.env['DATABASE_URL'] = ':memory:';
process.env['SUBSTRATE_ADMIN_KEY'] = 'test-admin-key';
process.env['SUBSTRATE_AGENT_KEY'] = 'test-agent-key';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '0';
