import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryRequest } from '../shared/types.js';
import { startTestServer, TestClient } from './helpers.js';

let server: Awaited<ReturnType<typeof startTestServer>>;
let mom: TestClient;
let runner: TestClient;

const newRequest = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: `req_${Math.random().toString(36).slice(2, 12)}`,
  title: 'Glass of water',
  description: 'Cold, please',
  location: 'Bedroom',
  priority: 'normal',
  notes: '',
  quickType: 'water',
  ...overrides,
});

async function createRequest(overrides: Record<string, unknown> = {}): Promise<DeliveryRequest> {
  const res = await mom.post('/api/requests', newRequest(overrides));
  expect(res.status).toBe(201);
  return res.body.request;
}

beforeEach(async () => {
  server = await startTestServer();
  mom = new TestClient(server.baseUrl);
  runner = new TestClient(server.baseUrl);
  await mom.login('mom', 'mom-password');
  await runner.login('sam', 'runner-password');
});

afterEach(async () => {
  await server.stop();
});

describe('authentication', () => {
  it('rejects requests without a session', async () => {
    const anon = new TestClient(server.baseUrl);
    expect((await anon.get('/api/me')).status).toBe(401);
    expect((await anon.get('/api/requests')).status).toBe(401);
    expect((await anon.get('/api/events')).status).toBe(401);
  });

  it('rejects a wrong password with a friendly message and no session', async () => {
    const anon = new TestClient(server.baseUrl);
    const res = await anon.post('/api/auth/login', { username: 'mom', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/don’t match/);
    expect(anon.cookie).toBe('');
  });

  it('sets an httpOnly session cookie and returns the profile', async () => {
    const anon = new TestClient(server.baseUrl);
    const res = await anon.post('/api/auth/login', { username: 'MOM', password: 'mom-password' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    expect(res.body.user).toMatchObject({ username: 'mom', role: 'mom', displayName: 'Mom' });
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(res.body.push.publicKey).toBeTruthy();
  });

  it('limits repeated failed sign-ins', async () => {
    const anon = new TestClient(server.baseUrl);
    for (let i = 0; i < 10; i++) await anon.post('/api/auth/login', { username: 'mom', password: 'wrong' });
    const res = await anon.post('/api/auth/login', { username: 'mom', password: 'mom-password' });
    expect(res.status).toBe(429);
  });

  it('signs out and stops accepting the old cookie', async () => {
    const cookie = mom.cookie;
    expect((await mom.post('/api/auth/logout')).status).toBe(200);
    const stale = new TestClient(server.baseUrl);
    stale.cookie = cookie;
    expect((await stale.get('/api/me')).status).toBe(401);
  });

  it('does not let a user change their own role', async () => {
    const res = await mom.patch('/api/me', { role: 'runner', displayName: 'Mum' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('mom');
    expect(res.body.user.displayName).toBe('Mum');
  });

  it('changes the password after checking the current one', async () => {
    expect((await mom.post('/api/me/password', { currentPassword: 'bad', newPassword: 'new-password-1' })).status).toBe(400);
    expect((await mom.post('/api/me/password', { currentPassword: 'mom-password', newPassword: 'new-password-1' })).status).toBe(200);
    expect((await mom.get('/api/me')).status).toBe(200); // this device stays signed in
    const other = new TestClient(server.baseUrl);
    expect((await other.post('/api/auth/login', { username: 'mom', password: 'new-password-1' })).status).toBe(200);
  });
});

describe('request protection', () => {
  it('requires JSON for changes', async () => {
    const res = await mom.request('POST', '/api/requests', undefined, { 'Content-Type': 'text/plain' });
    expect(res.status).toBe(415);
  });

  it('rejects changes from another origin', async () => {
    const res = await mom.request('POST', '/api/requests', newRequest(), { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});

describe('creating requests', () => {
  it('creates a pending request from text alone', async () => {
    const res = await mom.post('/api/requests', newRequest({ description: undefined, notes: undefined, quickType: undefined }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ status: 'pending', title: 'Glass of water', location: 'Bedroom', priority: 'normal', runner: null });
  });

  it('explains what is wrong with invalid input', async () => {
    const res = await mom.post('/api/requests', newRequest({ title: '   ', location: '', priority: 'whenever' }));
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toMatchObject({
      title: 'Tell us what you need.',
      location: 'Choose where it should go.',
      priority: 'Choose a priority.',
    });
  });

  it('treats a repeated submission as the same request', async () => {
    const body = newRequest();
    const first = await mom.post('/api/requests', body);
    const second = await mom.post('/api/requests', body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.request.id).toBe(first.body.request.id);
    expect(second.body.alreadyApplied).toBe(true);
    const list = await runner.get('/api/requests?scope=active');
    expect(list.body.requests).toHaveLength(1);
  });

  it('only lets Mom create requests', async () => {
    expect((await runner.post('/api/requests', newRequest())).status).toBe(403);
  });

  it('remembers the last location', async () => {
    await createRequest({ location: 'Garden bench' });
    const me = await mom.get('/api/me');
    expect(me.body.user.prefs.lastLocation).toBe('Garden bench');
  });
});

describe('lifecycle', () => {
  it('runs a full delivery with timestamps', async () => {
    const created = await createRequest();
    const accepted = await runner.post(`/api/requests/${created.id}/accept`, { etaMinutes: 5 });
    expect(accepted.status).toBe(200);
    expect(accepted.body.request).toMatchObject({ status: 'accepted', runner: { displayName: 'Sam' } });
    expect(accepted.body.request.acceptedAt).toBeTypeOf('number');
    const eta = accepted.body.request.etaAt - accepted.body.request.acceptedAt;
    expect(eta).toBe(5 * 60_000);

    const started = await runner.post(`/api/requests/${created.id}/start`);
    expect(started.body.request.status).toBe('in_progress');
    expect(started.body.request.startedAt).toBeTypeOf('number');
    expect(started.body.request.etaAt).toBe(accepted.body.request.etaAt);

    const delivered = await runner.post(`/api/requests/${created.id}/deliver`);
    expect(delivered.body.request.status).toBe('delivered');
    expect(delivered.body.request.deliveredAt).toBeTypeOf('number');

    const detail = await mom.get(`/api/requests/${created.id}`);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual(['created', 'accepted', 'started', 'delivered']);
  });

  it('refuses to deliver before accepting and starting', async () => {
    const created = await createRequest();
    const early = await runner.post(`/api/requests/${created.id}/deliver`);
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/Accept and start/);
    expect((await runner.post(`/api/requests/${created.id}/start`)).status).toBe(409);
    await runner.post(`/api/requests/${created.id}/accept`);
    const notStarted = await runner.post(`/api/requests/${created.id}/deliver`);
    expect(notStarted.status).toBe(409);
    expect(notStarted.body.error.message).toMatch(/Start the delivery/);
  });

  it('does not let Mom perform runner actions', async () => {
    const created = await createRequest();
    for (const action of ['accept', 'decline', 'start', 'deliver']) {
      expect((await mom.post(`/api/requests/${created.id}/${action}`)).status).toBe(403);
    }
    expect((await mom.post(`/api/requests/${created.id}/eta`, { etaMinutes: 5 })).status).toBe(403);
  });

  it('treats a repeated action by the same person as already done', async () => {
    const created = await createRequest();
    await runner.post(`/api/requests/${created.id}/accept`);
    const again = await runner.post(`/api/requests/${created.id}/accept`);
    expect(again.status).toBe(200);
    expect(again.body.alreadyApplied).toBe(true);
  });

  it('keeps finished requests final', async () => {
    const created = await createRequest();
    await runner.post(`/api/requests/${created.id}/decline`, { reason: 'Out of glasses' });
    const cancel = await mom.post(`/api/requests/${created.id}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.request.status).toBe('declined');
    expect((await mom.patch(`/api/requests/${created.id}`, { title: 'Tea' })).status).toBe(409);
  });

  it('reports a clear conflict when Mom cancels before the runner accepts', async () => {
    const created = await createRequest();
    expect((await mom.post(`/api/requests/${created.id}/cancel`)).status).toBe(200);
    const late = await runner.post(`/api/requests/${created.id}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.message).toBe('This request was cancelled.');
    expect(late.body.request.status).toBe('cancelled');
  });

  it('lets the runner cancel an accepted request with a reason, but decline (not cancel) a pending one', async () => {
    const created = await createRequest();
    expect((await runner.post(`/api/requests/${created.id}/cancel`)).status).toBe(409);
    await runner.post(`/api/requests/${created.id}/accept`);
    const res = await runner.post(`/api/requests/${created.id}/cancel`, { reason: 'We ran out' });
    expect(res.body.request).toMatchObject({ status: 'cancelled', cancelReason: 'We ran out', cancelledBy: { displayName: 'Sam' } });
  });

  it('lets Mom cancel until the delivery arrives', async () => {
    const created = await createRequest();
    await runner.post(`/api/requests/${created.id}/accept`);
    await runner.post(`/api/requests/${created.id}/start`);
    const res = await mom.post(`/api/requests/${created.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('cancelled');
  });

  it('validates ETA values', async () => {
    const created = await createRequest();
    await runner.post(`/api/requests/${created.id}/accept`);
    expect((await runner.post(`/api/requests/${created.id}/eta`, { etaMinutes: 0 })).status).toBe(400);
    expect((await runner.post(`/api/requests/${created.id}/eta`, { etaMinutes: 999 })).status).toBe(400);
    expect((await runner.post(`/api/requests/${created.id}/eta`, { etaMinutes: 1.5 })).status).toBe(400);
    expect((await runner.post(`/api/requests/${created.id}/eta`, { etaMinutes: 7 })).status).toBe(200);
  });
});

describe('privacy', () => {
  it('hides one family member’s requests from another requester', async () => {
    await server.users.create({ username: 'gran', password: 'gran-password', displayName: 'Gran', role: 'mom' });
    const gran = new TestClient(server.baseUrl);
    await gran.login('gran', 'gran-password');
    const created = await createRequest();
    expect((await gran.get(`/api/requests/${created.id}`)).status).toBe(404);
    expect((await gran.post(`/api/requests/${created.id}/cancel`)).status).toBe(404);
    expect((await gran.patch(`/api/requests/${created.id}`, { title: 'x' })).status).toBe(404);
    expect((await gran.get('/api/requests?scope=active')).body.requests).toHaveLength(0);
    expect((await gran.get('/api/activity')).body.events).toHaveLength(0);
  });

  it('keeps delivery records permanent at the database level', async () => {
    const created = await createRequest();
    expect(() => server.db.prepare('DELETE FROM requests WHERE id = ?').run(created.id)).toThrow(/cannot be deleted/);
    await mom.post(`/api/requests/${created.id}/cancel`);
    expect(() => server.db.prepare("UPDATE requests SET status = 'pending' WHERE id = ?").run(created.id)).toThrow(/cannot be changed/);
  });
});

describe('editing', () => {
  it('lets Mom edit and tells the runner what changed', async () => {
    const created = await createRequest();
    await runner.post(`/api/requests/${created.id}/accept`);
    const res = await mom.patch(`/api/requests/${created.id}`, { location: 'Kitchen', priority: 'urgent' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ location: 'Kitchen', priority: 'urgent', description: 'Cold, please' });
    const notes = await runner.get('/api/notifications');
    expect(notes.body.notifications[0]).toMatchObject({ type: 'details_updated', requestId: created.id });
    expect(notes.body.notifications[0].body).toContain('deliver to Kitchen');
    expect(notes.body.notifications[0].body).toContain('priority Urgent');
  });

  it('ignores edits that change nothing', async () => {
    const created = await createRequest();
    const res = await mom.patch(`/api/requests/${created.id}`, { title: 'Glass of water' });
    expect(res.body.alreadyApplied).toBe(true);
  });

  it('does not let the runner edit details', async () => {
    const created = await createRequest();
    expect((await runner.patch(`/api/requests/${created.id}`, { title: 'Nothing' })).status).toBe(403);
  });
});

describe('history', () => {
  it('lists finished requests with filters and pages', async () => {
    const a = await createRequest({ title: 'A' });
    const b = await createRequest({ title: 'B' });
    const c = await createRequest({ title: 'C' });
    await createRequest({ title: 'Still pending' });
    await runner.post(`/api/requests/${a.id}/accept`);
    await runner.post(`/api/requests/${a.id}/start`);
    await runner.post(`/api/requests/${a.id}/deliver`);
    await runner.post(`/api/requests/${b.id}/decline`);
    await mom.post(`/api/requests/${c.id}/cancel`);

    const all = await mom.get('/api/requests?scope=history');
    expect(all.body.requests.map((r: DeliveryRequest) => r.title)).toEqual(['C', 'B', 'A']);
    const delivered = await runner.get('/api/requests?scope=history&status=delivered');
    expect(delivered.body.requests.map((r: DeliveryRequest) => r.title)).toEqual(['A']);
    const page1 = await mom.get('/api/requests?scope=history&limit=2');
    expect(page1.body.requests).toHaveLength(2);
    const page2 = await mom.get(`/api/requests?scope=history&limit=2&before=${page1.body.nextCursor}`);
    expect(page2.body.requests.map((r: DeliveryRequest) => r.title)).toEqual(['A']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('counts today’s deliveries', async () => {
    const a = await createRequest();
    await runner.post(`/api/requests/${a.id}/accept`);
    await runner.post(`/api/requests/${a.id}/start`);
    await runner.post(`/api/requests/${a.id}/deliver`);
    const stats = await runner.get(`/api/stats?since=${Date.now() - 60_000}`);
    expect(stats.body.deliveredToday).toBe(1);
  });
});

describe('notifications', () => {
  it('notifies the right people at each step', async () => {
    const created = await createRequest({ priority: 'urgent' });
    let runnerNotes = (await runner.get('/api/notifications')).body;
    expect(runnerNotes.unreadCount).toBe(1);
    expect(runnerNotes.notifications[0]).toMatchObject({ type: 'new_request', title: 'Urgent request from Mom' });

    await runner.post(`/api/requests/${created.id}/accept`, { etaMinutes: 5 });
    await runner.post(`/api/requests/${created.id}/eta`, { etaMinutes: 6 }); // small change: no notification
    await runner.post(`/api/requests/${created.id}/eta`, { etaMinutes: 15 }); // big change: notify
    await runner.post(`/api/requests/${created.id}/start`);
    await runner.post(`/api/requests/${created.id}/deliver`);

    const momNotes = (await mom.get('/api/notifications')).body;
    expect(momNotes.notifications.map((n: { type: string }) => n.type)).toEqual(['delivered', 'started', 'eta_updated', 'accepted', 'submitted']);
    expect(momNotes.unreadCount).toBe(5);

    const read = await mom.post('/api/notifications/read', { ids: [momNotes.notifications[0].id] });
    expect(read.body.unreadCount).toBe(4);
    const byRequest = await mom.post('/api/notifications/read', { requestId: created.id });
    expect(byRequest.body.unreadCount).toBe(0);

    runnerNotes = (await runner.post('/api/notifications/read', { all: true })).body;
    expect(runnerNotes.unreadCount).toBe(0);
  });

  it('tells the runner when Mom cancels', async () => {
    const created = await createRequest();
    await mom.post(`/api/requests/${created.id}/cancel`, { reason: 'Found it myself' });
    const notes = (await runner.get('/api/notifications')).body.notifications;
    expect(notes[0]).toMatchObject({ type: 'cancelled', body: '“Glass of water” is no longer needed: Found it myself' });
  });

  it('cannot mark someone else’s notifications as read', async () => {
    await createRequest();
    const runnerNote = (await runner.get('/api/notifications')).body.notifications[0];
    await mom.post('/api/notifications/read', { ids: [runnerNote.id] });
    expect((await runner.get('/api/notifications')).body.unreadCount).toBe(1);
  });
});

describe('push notifications', () => {
  const subscription = (endpoint: string) => ({ subscription: { endpoint, keys: { p256dh: 'BPk', auth: 'auth' } } });

  it('sends a push that opens the request, respecting preferences', async () => {
    await mom.post('/api/push/subscribe', subscription('https://push.example/mom-phone'));
    const created = await createRequest();
    await runner.post(`/api/requests/${created.id}/accept`, { etaMinutes: 3 });
    await server.notifier.settle();
    const accepted = server.pushes.find((p) => p.payload.type === 'accepted');
    expect(accepted?.endpoint).toBe('https://push.example/mom-phone');
    expect(accepted?.payload.url).toBe(`/requests/${created.id}`);
    // "Request sent" confirmations are off by default for push.
    expect(server.pushes.some((p) => p.payload.type === 'submitted')).toBe(false);

    await mom.patch('/api/me', { prefs: { push: { started: false } } });
    await runner.post(`/api/requests/${created.id}/start`);
    await server.notifier.settle();
    expect(server.pushes.some((p) => p.payload.type === 'started')).toBe(false);
    // The in-app notification is still recorded.
    expect((await mom.get('/api/notifications')).body.notifications[0].type).toBe('started');
  });

  it('drops subscriptions the push service says are gone', async () => {
    await runner.post('/api/push/subscribe', subscription('https://push.example/old'));
    server.goneEndpoints.add('https://push.example/old');
    await createRequest();
    await server.notifier.settle();
    const status = await runner.post('/api/push/status', { endpoint: 'https://push.example/old' });
    expect(status.body.subscribed).toBe(false);
  });

  it('stops pushing to a device after it signs out', async () => {
    await runner.post('/api/push/subscribe', subscription('https://push.example/shared-tablet'));
    await runner.post('/api/auth/logout');
    await createRequest();
    await server.notifier.settle();
    expect(server.pushes).toHaveLength(0);
  });

  it('reports how many devices a test push reached', async () => {
    expect((await mom.post('/api/push/test')).body).toEqual({ attempted: 0, delivered: 0 });
    await mom.post('/api/push/subscribe', subscription('https://push.example/a'));
    expect((await mom.post('/api/push/test')).body).toEqual({ attempted: 1, delivered: 1 });
  });

  it('only accepts HTTPS push endpoints', async () => {
    expect((await mom.post('/api/push/subscribe', subscription('http://push.example/x'))).status).toBe(400);
  });
});

describe('live updates', () => {
  it('delivers changes to both people instantly', async () => {
    const runnerLive = await runner.listen();
    const momLive = await mom.listen();
    expect(runnerLive.status).toBe(200);
    await runnerLive.next((e) => e.type === 'hello');

    const created = await createRequest();
    const seen = await runnerLive.next((e) => e.type === 'request' && e.request.id === created.id);
    expect(seen.type === 'request' && seen.request.status).toBe('pending');
    await runnerLive.next((e) => e.type === 'notification' && e.notification.type === 'new_request');

    await runner.post(`/api/requests/${created.id}/accept`, { etaMinutes: 4 });
    const update = await momLive.next((e) => e.type === 'request' && e.request.status === 'accepted');
    expect(update.type === 'request' && update.event?.type).toBe('accepted');
    await momLive.next((e) => e.type === 'notification' && e.notification.type === 'accepted');

    runnerLive.close();
    momLive.close();
  });

  it('does not send one requester’s updates to another', async () => {
    await server.users.create({ username: 'gran', password: 'gran-password', displayName: 'Gran', role: 'mom' });
    const gran = new TestClient(server.baseUrl);
    await gran.login('gran', 'gran-password');
    const granLive = await gran.listen();
    await granLive.next((e) => e.type === 'hello');
    await createRequest();
    await new Promise((r) => setTimeout(r, 100));
    expect(granLive.events.filter((e) => e.type !== 'hello')).toHaveLength(0);
    granLive.close();
  });
});
