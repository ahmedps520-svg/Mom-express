import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  databaseFile: string;
  webDir: string;
  sessionDays: number;
  /** Express "trust proxy" setting, needed behind a reverse proxy for HTTPS detection. */
  trustProxy: boolean | number | string;
  /** 'auto' marks cookies Secure whenever the request arrived over HTTPS. */
  cookieSecure: 'auto' | boolean;
  /** Extra origins allowed to send state-changing requests (the app's own origin is always allowed). */
  allowedOrigins: string[];
  vapid: { publicKey?: string; privateKey?: string; subject: string };
  initialUsers: { username: string; password: string; displayName: string; role: 'mom' | 'runner' }[];
}

let envLoaded = false;

/** Loads `.env` from the working directory if there is one (real env vars win). */
export function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = path.resolve('.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? 'data');
  const initialUsers: Config['initialUsers'] = [];
  for (const role of ['mom', 'runner'] as const) {
    const prefix = `INITIAL_${role.toUpperCase()}_`;
    const username = env[`${prefix}USERNAME`];
    const password = env[`${prefix}PASSWORD`];
    if (username && password) {
      initialUsers.push({
        username,
        password,
        displayName: env[`${prefix}NAME`] || (role === 'mom' ? 'Mom' : username),
        role,
      });
    }
  }

  const cookieSecure = env.COOKIE_SECURE === 'true' ? true : env.COOKIE_SECURE === 'false' ? false : 'auto';

  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    databaseFile: env.DATABASE_FILE ? path.resolve(env.DATABASE_FILE) : path.join(dataDir, 'momexpress.db'),
    webDir: path.resolve(env.WEB_DIR ?? 'dist/web'),
    sessionDays: Number(env.SESSION_DAYS ?? 90),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cookieSecure,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || undefined,
      privateKey: env.VAPID_PRIVATE_KEY || undefined,
      subject: env.VAPID_SUBJECT || 'mailto:momexpress@example.com',
    },
    initialUsers,
  };
}
