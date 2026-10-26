import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { DB } from './db.js';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

/** Hashes a password as `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// A fixed hash to compare against when the username doesn't exist, so a wrong
// username takes as long as a wrong password.
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export const SESSION_COOKIE = 'mx_session';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface SessionRow {
  id: string;
  user_id: number;
  expires_at: number;
  last_seen_at: number;
}

export class SessionStore {
  constructor(
    private db: DB,
    private ttlMs: number,
  ) {}

  /** Creates a session and returns the raw token for the cookie (only its hash is stored). */
  create(userId: number, userAgent: string | undefined): { token: string; sessionId: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const sessionId = hashToken(token);
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, userId, now, now, expiresAt, userAgent?.slice(0, 300) ?? null);
    return { token, sessionId, expiresAt };
  }

  /**
   * Looks up a session by cookie token. Sessions slide: each use (at most once
   * an hour) pushes the expiry out again, so a household device stays signed in.
   */
  touch(token: string): { session: SessionRow; renewed: boolean } | null {
    const id = hashToken(token);
    const session = this.db
      .prepare('SELECT id, user_id, expires_at, last_seen_at FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (!session) return null;
    const now = Date.now();
    if (session.expires_at <= now) {
      this.destroy(id);
      return null;
    }
    if (now - session.last_seen_at > 60 * 60_000) {
      session.last_seen_at = now;
      session.expires_at = now + this.ttlMs;
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, session.expires_at, id);
      return { session, renewed: true };
    }
    return { session, renewed: false };
  }

  isValid(sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.disabled_at IS NULL')
      .get(sessionId, Date.now());
  }

  destroy(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  destroyAllForUser(userId: number, exceptSessionId?: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, exceptSessionId ?? null);
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
}

/**
 * A small in-memory limiter for sign-in attempts: after `max` failures within
 * `windowMs`, further attempts for that key are refused until the window passes.
 */
export class AttemptLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  retryAfterMs(key: string): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.resetAt <= now) {
      this.attempts.delete(key);
      return 0;
    }
    return entry.count >= this.max ? entry.resetAt - now : 0;
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
