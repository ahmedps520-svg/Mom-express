import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Runs the real MomExpress migration in an in-memory Postgres (PGlite), with
// small stand-ins for the Supabase pieces it relies on: the auth schema, the
// API roles, and pg_net (whose HTTP calls are recorded instead of sent).
const SUPABASE_STANDINS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema extensions;
  create extension pgcrypto with schema extensions;

  create schema auth;
  create table auth.users (
    instance_id uuid, id uuid primary key, aud text, role text, email text unique, encrypted_password text,
    email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
    created_at timestamptz, updated_at timestamptz, confirmation_token text, recovery_token text,
    email_change text, email_change_token_new text, email_change_token_current text,
    phone_change text, phone_change_token text, reauthentication_token text);
  create table auth.identities (
    id uuid primary key, provider_id text, user_id uuid references auth.users (id) on delete cascade,
    identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
  create table auth.sessions (id uuid primary key, user_id uuid references auth.users (id) on delete cascade, not_after timestamptz);
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;

  create schema net;
  create table net.calls (id serial primary key, url text, body jsonb);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
  language sql as $$ insert into net.calls (url, body) values (url, body) returning id $$;

  create publication supabase_realtime;
`;

export interface DbError extends Error {
  code?: string;
  hint?: string;
  detail?: string;
}

export async function createTestDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STANDINS);
  const migrationDir = path.resolve('supabase/migrations');
  for (const file of fs.readdirSync(migrationDir).sort()) {
    const sql = fs
      .readFileSync(path.join(migrationDir, file), 'utf8')
      // Provided by the stand-ins above.
      .replace(/^create extension if not exists (pgcrypto|pg_net)[^\n]*$/gm, '');
    await db.exec(sql);
  }

  let current: { userId: string; sessionId: string } | null = null;

  /**
   * Runs a query as a signed-in person (or anonymously with null), like
   * PostgREST does. Each call gets a savepoint, so a failing call doesn't
   * spoil the rest of the test's transaction.
   */
  async function as<T = any>(who: { userId: string; sessionId: string } | null, sql: string, params: unknown[] = []): Promise<T> {
    current = who;
    const claims = who ? JSON.stringify({ sub: who.userId, session_id: who.sessionId, role: 'authenticated' }) : '';
    await db.exec('savepoint call');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await db.exec(`set local role ${who ? 'authenticated' : 'anon'}`);
    try {
      const res = await db.query<{ result: T }>(sql, params);
      await db.exec('reset role; release savepoint call');
      return res.rows[0]?.result as T;
    } catch (err) {
      await db.exec('rollback to savepoint call; reset role');
      throw err;
    } finally {
      current = null;
    }
  }

  /** Each test runs in a transaction that is rolled back afterwards. */
  const begin = () => db.exec('begin');
  const rollback = () => db.exec('rollback');

  /** Calls a public.mx_* function as someone, with named arguments. */
  function rpc<T = any>(who: { userId: string; sessionId: string } | null, fn: string, args: Record<string, unknown> = {}) {
    const names = Object.keys(args);
    const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
    return as<T>(who, `select public.${fn}(${list}) as result`, names.map((n) => args[n]));
  }

  async function member(username: string, displayName: string, role: 'mom' | 'runner') {
    const res = await db.query<{ id: string }>(`select momexpress.create_member($1, $2, $3, $4) as id`, [username, 'password-123', displayName, role]);
    const userId = res.rows[0].id;
    const sessionId = crypto.randomUUID();
    await db.query('insert into auth.sessions (id, user_id) values ($1, $2)', [sessionId, userId]);
    return { userId, sessionId };
  }

  /** Expects a call to fail with an HTTP-style status (PostgREST maps SQLSTATE PTnnn to nnn). */
  async function expectError(promise: Promise<unknown>, status: number): Promise<DbError> {
    try {
      await promise;
    } catch (err) {
      const e = err as DbError;
      if (e.code !== `PT${status}`) throw new Error(`expected PT${status}, got ${e.code}: ${e.message}`);
      return e;
    }
    throw new Error(`expected an error PT${status}, but the call succeeded`);
  }

  return { db, as, rpc, member, expectError, begin, rollback, get current() { return current; } };
}
