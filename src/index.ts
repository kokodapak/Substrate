import './config'; // Validates env vars — must be first import
import { config } from './config';
import { app } from './app';
import { runMigrations, loadAndRegisterPluginRules } from './db/migrate';
import { startFederationSync } from './services/federation';

if (config.sentryDsn) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Sentry = require('@sentry/node');
  Sentry.init({ dsn: config.sentryDsn });
}

runMigrations();
loadAndRegisterPluginRules();

app.listen(config.port, () => {
  startFederationSync();
});
