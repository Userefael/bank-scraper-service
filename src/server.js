'use strict';

const { createApp } = require('./app');
const config = require('./config');
const logger = require('./logger');
const sessions = require('./sessions');
const store = require('./store');
const { loadKey } = require('./crypto');

/** Fails fast on a misconfigured deployment instead of at the first request. */
function assertConfig() {
  const missing = [];
  if (!process.env.SCRAPER_API_KEY) missing.push('SCRAPER_API_KEY');
  if (!process.env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  loadKey();
}

async function main() {
  assertConfig();
  await store.ensureDataDir();

  const app = createApp();
  const server = app.listen(config.port(), () => {
    logger.info('listening', { status: config.port() });
  });

  const shutdown = (signal) => {
    logger.info('shutting_down', { event: signal });
    sessions.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Startup failures are configuration problems; the message is ours, not user data.
  logger.error('startup_failed', { event: err.message });
  process.exit(1);
});
