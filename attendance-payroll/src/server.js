'use strict';
const config = require('./config');
const { pool } = require('./db');
const { waitForDb, migrate, firstRun } = require('./bootstrap');
const { getSecret, randomSecret, getSettings } = require('./services/settings');
const { setSecret } = require('./middleware/auth');
const { initPush } = require('./services/notifications');
const scheduler = require('./services/scheduler');
const { createApp } = require('./app');

async function main() {
  await waitForDb();
  await migrate();
  await getSettings();
  // Signing key and Web Push (VAPID) keys: generated once and kept in the database unless provided via env.
  setSecret(config.jwtSecret || await getSecret('jwt', randomSecret));
  await initPush();
  await firstRun();

  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[server] listening on :${config.port} (${config.env})`));
  if (config.schedulerEnabled) scheduler.start();

  const shutdown = (sig) => {
    console.log(`[server] ${sig} received, shutting down`);
    scheduler.stop();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
