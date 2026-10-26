import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

// Each entry upgrades the schema by one version. Never edit a migration that
// has shipped; add a new one instead.
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('mom', 'runner')),
    password_hash TEXT    NOT NULL,
    prefs         TEXT    NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    disabled_at   INTEGER
  );

  CREATE TABLE sessions (
    id           TEXT    PRIMARY KEY,               -- SHA-256 of the cookie token
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE requests (
    id                 INTEGER PRIMARY KEY,
    requester_id       INTEGER NOT NULL REFERENCES users(id),
    runner_id          INTEGER REFERENCES users(id),
    client_request_id  TEXT    NOT NULL,
    title              TEXT    NOT NULL,
    description        TEXT    NOT NULL DEFAULT '',
    location           TEXT    NOT NULL,
    priority           TEXT    NOT NULL CHECK (priority IN ('normal', 'high', 'urgent')),
    notes              TEXT    NOT NULL DEFAULT '',
    quick_type         TEXT,
    status             TEXT    NOT NULL CHECK (status IN ('pending', 'accepted', 'in_progress', 'delivered', 'declined', 'cancelled')),
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    accepted_at        INTEGER,
    started_at         INTEGER,
    delivered_at       INTEGER,
    declined_at        INTEGER,
    cancelled_at       INTEGER,
    eta_at             INTEGER,
    eta_set_at         INTEGER,
    decline_reason     TEXT,
    cancel_reason      TEXT,
    cancelled_by       INTEGER REFERENCES users(id),
    details_updated_at INTEGER,
    version            INTEGER NOT NULL DEFAULT 1,
    UNIQUE (requester_id, client_request_id)
  );
  CREATE INDEX requests_status ON requests(status);
  CREATE INDEX requests_requester ON requests(requester_id, created_at);
  CREATE INDEX requests_updated ON requests(updated_at);

  -- Delivery records are permanent: they can't be deleted, and once a request
  -- reaches a final state it can't be changed.
  CREATE TRIGGER requests_no_delete BEFORE DELETE ON requests
  BEGIN
    SELECT RAISE(ABORT, 'delivery records cannot be deleted');
  END;
  CREATE TRIGGER requests_final_is_final BEFORE UPDATE ON requests
  WHEN OLD.status IN ('delivered', 'declined', 'cancelled')
  BEGIN
    SELECT RAISE(ABORT, 'finished requests cannot be changed');
  END;

  CREATE TABLE request_events (
    id         INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    actor_id   INTEGER REFERENCES users(id),
    type       TEXT    NOT NULL,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX request_events_request ON request_events(request_id, id);
  CREATE TRIGGER request_events_append_only_update BEFORE UPDATE ON request_events
  BEGIN
    SELECT RAISE(ABORT, 'request history is append-only');
  END;
  CREATE TRIGGER request_events_append_only_delete BEFORE DELETE ON request_events
  BEGIN
    SELECT RAISE(ABORT, 'request history is append-only');
  END;

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id INTEGER REFERENCES requests(id),
    type       TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );
  CREATE INDEX notifications_user ON notifications(user_id, id);
  CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

  -- A push subscription belongs to the session that registered it, so signing
  -- out (or the session expiring) stops that device's notifications.
  CREATE TABLE push_subscriptions (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint        TEXT    NOT NULL UNIQUE,
    p256dh          TEXT    NOT NULL,
    auth            TEXT    NOT NULL,
    user_agent      TEXT,
    created_at      INTEGER NOT NULL,
    last_success_at INTEGER,
    failure_count   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

  CREATE TABLE app_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getKv(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO app_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
