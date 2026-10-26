import { defaultPrefs } from '../shared/constants.js';
import type { PublicUser, Role, UserPrefs } from '../shared/types.js';
import { hashPassword } from './auth.js';
import type { DB } from './db.js';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  prefs: string;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
}

/** Stored prefs merged over the role's defaults, so new settings get sensible values. */
export function readPrefs(row: Pick<UserRow, 'role' | 'prefs'>): UserPrefs {
  const defaults = defaultPrefs(row.role);
  let stored: Partial<UserPrefs> = {};
  try {
    stored = JSON.parse(row.prefs) as Partial<UserPrefs>;
  } catch {
    stored = {};
  }
  return { ...defaults, ...stored, push: { ...defaults.push, ...(stored.push ?? {}) } };
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    prefs: readPrefs(row),
  };
}

export class UserStore {
  constructor(private db: DB) {}

  byId(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserRow | undefined;
  }

  /** Active (not disabled) users with a role, e.g. every runner to notify. */
  activeByRole(role: Role): UserRow[] {
    return this.db.prepare('SELECT * FROM users WHERE role = ? AND disabled_at IS NULL ORDER BY id').all(role) as unknown as UserRow[];
  }

  all(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  async create(input: { username: string; password: string; displayName: string; role: Role }): Promise<UserRow> {
    const now = Date.now();
    const hash = await hashPassword(input.password);
    const result = this.db
      .prepare(
        'INSERT INTO users (username, display_name, role, password_hash, prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.username.trim(), input.displayName.trim(), input.role, hash, JSON.stringify(defaultPrefs(input.role)), now, now);
    return this.byId(Number(result.lastInsertRowid))!;
  }

  async setPassword(id: number, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, Date.now(), id);
  }

  update(id: number, changes: { displayName?: string; prefs?: Partial<UserPrefs> }): UserRow {
    const row = this.byId(id);
    if (!row) throw new Error(`No user ${id}`);
    const current = readPrefs(row);
    const prefs: UserPrefs = changes.prefs
      ? { ...current, ...changes.prefs, push: { ...current.push, ...(changes.prefs.push ?? {}) } }
      : current;
    this.db
      .prepare('UPDATE users SET display_name = ?, prefs = ?, updated_at = ? WHERE id = ?')
      .run(changes.displayName ?? row.display_name, JSON.stringify(prefs), Date.now(), id);
    return this.byId(id)!;
  }

  setDisabled(id: number, disabled: boolean): void {
    this.db.prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?').run(disabled ? Date.now() : null, Date.now(), id);
  }
}
