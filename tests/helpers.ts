import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { RequestOptions, SendResult } from 'web-push';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import type { LiveEvent } from '../shared/types.js';

export interface SentPush {
  endpoint: string;
  payload: Record<string, unknown>;
  options: RequestOptions;
}

/** Starts a real server on a random port with an in-memory database. */
export async function startTestServer() {
  const config = { ...readConfig({}), webDir: '/nonexistent', cookieSecure: false as const };
  const db = openDatabase(':memory:');
  const pushes: SentPush[] = [];
  const goneEndpoints = new Set<string>();
  const ctx = createApp({
    config,
    db,
    pushSender: async (sub, payload, options) => {
      if (goneEndpoints.has(sub.endpoint)) throw Object.assign(new Error('gone'), { statusCode: 410 });
      pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
      return { statusCode: 201, body: '', headers: {} } as SendResult;
    },
  });
  const server: Server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mom = await ctx.users.create({ username: 'mom', password: 'mom-password', displayName: 'Mom', role: 'mom' });
  const runner = await ctx.users.create({ username: 'sam', password: 'runner-password', displayName: 'Sam', role: 'runner' });
  return {
    ...ctx,
    db,
    baseUrl,
    pushes,
    goneEndpoints,
    mom,
    runner,
    async stop() {
      ctx.close();
      await new Promise((r) => server.close(r));
      await ctx.notifier.settle();
      db.close();
    },
  };
}

export class TestClient {
  cookie = '';
  constructor(private baseUrl: string) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body: unknown = {}) {
    return this.request('POST', path, body);
  }
  patch(path: string, body: unknown) {
    return this.request('PATCH', path, body);
  }

  async login(username: string, password: string) {
    const res = await this.post('/api/auth/login', { username, password });
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /** Opens the live event stream and collects events as they arrive. */
  async listen() {
    const controller = new AbortController();
    const res = await fetch(this.baseUrl + '/api/events', { headers: { Cookie: this.cookie }, signal: controller.signal });
    const events: LiveEvent[] = [];
    const waiters: { test: (e: LiveEvent) => boolean; resolve: (e: LiveEvent) => void }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6)) as LiveEvent;
            events.push(event);
            for (const w of [...waiters]) {
              if (w.test(event)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(event);
              }
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return {
      status: res.status,
      events,
      next(test: (e: LiveEvent) => boolean, timeoutMs = 2000): Promise<LiveEvent> {
        const found = events.find(test);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out waiting for live event')), timeoutMs);
          waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
        });
      },
      close: () => controller.abort(),
    };
  }
}
