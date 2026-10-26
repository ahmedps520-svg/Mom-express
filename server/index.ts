import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadEnvFile, readConfig } from './config.js';
import { openDatabase } from './db.js';
import { UserStore } from './users.js';

loadEnvFile();
const config = readConfig();
const db = openDatabase(config.databaseFile);

// Create the first accounts from the environment on a brand-new install, for
// hosts where running the `users` command isn't convenient.
const users = new UserStore(db);
if (users.count() === 0) {
  for (const initial of config.initialUsers) {
    await users.create(initial);
    console.log(`[setup] created ${initial.role} account "${initial.username}"`);
  }
}
if (users.count() === 0) {
  console.warn('[setup] No accounts exist yet. Create them with:  npm run users -- add');
}

const { app, sessions, notifier, close } = createApp({ config, db });

if (!fs.existsSync(path.join(config.webDir, 'index.html'))) {
  console.warn(`[web] No built app found in ${config.webDir}. Run "npm run build" (or use "npm run dev" while developing).`);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`MomExpress is running on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});

const purge = setInterval(() => sessions.purgeExpired(), 6 * 60 * 60_000);
purge.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  clearInterval(purge);
  close();
  server.close();
  await notifier.settle();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
