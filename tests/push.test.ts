import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpush, { type SendResult } from 'web-push';
import { openDatabase } from '../server/db.js';
import { PushService, type PushSender } from '../server/push.js';

// Builds real, encrypted, VAPID-signed Web Push requests with the web-push
// library and delivers them to a local stand-in for a browser's push service,
// which decrypts them the way the browser would. (Real push services are
// HTTPS-only, so the request is sent over plain HTTP to the local server.)
const ece = createRequire(import.meta.url)('http_ece') as {
  decrypt(buffer: Buffer, params: { version: string; privateKey: crypto.ECDH; authSecret: string }): Buffer;
};

interface Received {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server;
let endpointBase: string;
let respondWith = 201;
const received: Received[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(respondWith).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpointBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
}

function setup() {
  const db = openDatabase(':memory:');
  const now = Date.now();
  db.prepare("INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at) VALUES (1, 'mom', 'Mom', 'mom', 'x', ?, ?)").run(now, now);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, 1, ?, ?, ?)').run('s1', now, now, now + 60_000);
  return { db, push: new PushService(db, 'mailto:test@example.com', {}, sendOverHttp) };
}

const sendOverHttp: PushSender = async (subscription, body, options) => {
  const request = webpush.generateRequestDetails(subscription, body, options);
  const res = await fetch(request.endpoint, { method: request.method, headers: request.headers, body: request.body as Buffer });
  if (res.status >= 400) throw Object.assign(new Error(`push service said ${res.status}`), { statusCode: res.status });
  return { statusCode: res.status, body: '', headers: {} } as SendResult;
};

const payload = {
  title: 'Delivered!',
  body: '“Glass of water” was delivered to Bedroom. Enjoy!',
  url: '/requests/7',
  tag: 'request-7',
  type: 'delivered' as const,
  requestId: 7,
  notificationId: 3,
  priority: 'urgent' as const,
  badgeCount: 2,
};

describe('web push delivery', () => {
  it('sends an encrypted, VAPID-signed message that the browser can decrypt', async () => {
    const { db, push } = setup();
    const keys = browserKeys();
    push.saveSubscription({ userId: 1, sessionId: 's1', endpoint: `${endpointBase}/push/abc`, p256dh: keys.p256dh, auth: keys.auth });

    const outcome = await push.sendToUser(1, payload);
    expect(outcome).toEqual({ attempted: 1, delivered: 1 });

    const msg = received.at(-1)!;
    expect(msg.headers['content-encoding']).toBe('aes128gcm');
    expect(msg.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(msg.headers.urgency).toBe('high');
    expect(msg.headers.topic).toBe('request-7');
    expect(Number(msg.headers.ttl)).toBeGreaterThan(0);

    const decrypted = ece.decrypt(msg.body, { version: 'aes128gcm', privateKey: keys.ecdh, authSecret: keys.auth });
    expect(JSON.parse(decrypted.toString('utf8'))).toEqual(payload);
    db.close();
  });

  it('keeps the same VAPID keys across restarts so subscriptions stay valid', () => {
    const db = openDatabase(':memory:');
    const first = new PushService(db, 'mailto:test@example.com', {});
    const second = new PushService(db, 'mailto:test@example.com', {});
    expect(second.publicKey).toBe(first.publicKey);
    db.close();
  });

  it('forgets a subscription the push service reports as gone', async () => {
    const { db, push } = setup();
    const keys = browserKeys();
    const endpoint = `${endpointBase}/push/expired`;
    push.saveSubscription({ userId: 1, sessionId: 's1', endpoint, p256dh: keys.p256dh, auth: keys.auth });
    respondWith = 410;
    try {
      expect(await push.sendToUser(1, payload)).toEqual({ attempted: 1, delivered: 0 });
    } finally {
      respondWith = 201;
    }
    expect(push.hasSubscription(1, endpoint)).toBe(false);
    db.close();
  });
});
