import * as dotenv from 'dotenv';
dotenv.config();

const REQUIRED_VARS = [
  'SUBSTRATE_ADMIN_KEY',
  'SUBSTRATE_AGENT_KEY',
  'DATABASE_URL',
  'NODE_ENV',
  'PORT',
] as const;

function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please set them in your .env file. See .env.example for reference.'
    );
  }
}

validateEnv();

export const config = {
  adminKey: process.env['SUBSTRATE_ADMIN_KEY'] as string,
  agentKey: process.env['SUBSTRATE_AGENT_KEY'] as string,
  databaseUrl: process.env['DATABASE_URL'] as string,
  nodeEnv: process.env['NODE_ENV'] as string,
  port: parseInt(process.env['PORT'] as string, 10),
  dockerSocketPath: process.env['DOCKER_SOCKET_PATH'] ?? '/var/run/docker.sock',
  sentryDsn: process.env['SENTRY_DSN'] ?? null,
} as const;
