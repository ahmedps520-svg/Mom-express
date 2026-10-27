import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryRequest } from '../../shared/types.js';
import { createTestDb } from './harness.js';

type Who = { userId: string; sessionId: string };

let t: Awaited<ReturnType<typeof createTestDb>>;
let mom: Who;
let runner: Who;

let seq = 0;
const newRequest = (overrides: Record<string, unknown> = {}) => ({
  p_client_request_id: `req_${Date.now()}_${seq++}`,
  p_title: 'Glass of water',
  p_description: 'Cold, please',
  p_location: 'Bedroom',
  p_priority: 'normal',
  p_notes: '',
  p_quick_type: 'water',
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}): Promise<DeliveryRequest> {
  const res = await t.rpc(mom, 'mx_create_request', newRequest(overrides));
  return res.request;
}

const notificationsOf = async (who: Who) => (await t.rpc(who, 'mx_notifications')).notifications as { type: string; body: string; title: string; id: number }[];

beforeAll(async () => {
  t = await createTestDb();
});

beforeEach(async () => {
  await t.begin();
  mom = await t.member('mom', 'Mom', 'mom');
  runner = await t.member('sam', 'Sam', 'runner');
});

afterEach(async () => {
  await t.rollback();
});

describe('access', () => {
  it('refuses anonymous visitors outright', async () => {
    await expect(t.rpc(null, 'mx_me')).rejects.toThrow(/permission denied/);
    await expect(t.as(null, 'select count(*) as result from momexpress.requests')).rejects.toThrow(/permission denied/);
  });

  it('refuses signed-in accounts that are not MomExpress members', async () => {
    const stranger = { userId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const err = await t.expectError(t.rpc(stranger, 'mx_me'), 403);
    expect(err.message).toBe('This account isn’t part of MomExpress.');
  });

  it('returns the profile with defaults and never lets someone change their role', async () => {
    const me = await t.rpc(mom, 'mx_me');
    expect(me.user).toMatchObject({ username: 'mom', displayName: 'Mom', role: 'mom', prefs: { sound: true, theme: 'system' } });
    expect(me.user.prefs.push.submitted).toBe(false);
    const updated = await t.rpc(mom, 'mx_update_me', { p_display_name: '  Mum  ', p_prefs: { role: 'runner', theme: 'dark', push: { started: false, bogus: true } } });
    expect(updated.user).toMatchObject({ role: 'mom', displayName: 'Mum' });
    expect(updated.user.prefs.theme).toBe('dark');
    expect(updated.user.prefs.push.started).toBe(false);
    expect(updated.user.prefs.push).not.toHaveProperty('bogus');
  });

  it('keeps the internal functions out of reach', async () => {
    await expect(t.as(mom, `select momexpress.create_member('x1', 'password-123', 'X', 'runner') as result`)).rejects.toThrow(/permission denied/);
    await expect(t.rpc(mom, 'mx_push_claim', { p_notification_id: 1 })).rejects.toThrow(/permission denied/);
    await expect(t.rpc(mom, 'mx_push_vapid')).rejects.toThrow(/permission denied/);
  });
});

describe('creating requests', () => {
  it('creates a pending request from text alone', async () => {
    const res = await t.rpc(mom, 'mx_create_request', { p_client_request_id: 'abcdefgh1', p_title: '  Phone   charger ', p_location: 'Kitchen', p_priority: 'normal' });
    expect(res.created).toBe(true);
    expect(res.request).toMatchObject({ status: 'pending', title: 'Phone charger', location: 'Kitchen', description: '', runner: null, requester: { displayName: 'Mom' } });
    expect(res.event).toMatchObject({ type: 'created', actor: { displayName: 'Mom' } });
  });

  it('explains what is wrong with invalid input', async () => {
    const err = await t.expectError(t.rpc(mom, 'mx_create_request', newRequest({ p_title: '   ', p_location: '', p_priority: 'whenever' })), 400);
    expect(JSON.parse(err.detail!).fields).toEqual({
      title: 'Tell us what you need.',
      location: 'Choose where it should go.',
      priority: 'Choose a priority.',
    });
  });

  it('treats a repeated submission as the same request', async () => {
    const body = newRequest();
    const first = await t.rpc(mom, 'mx_create_request', body);
    const second = await t.rpc(mom, 'mx_create_request', body);
    expect(second).toMatchObject({ created: false, alreadyApplied: true });
    expect(second.request.id).toBe(first.request.id);
    expect((await t.rpc(runner, 'mx_list_active')).requests).toHaveLength(1);
  });

  it('only lets Mom create requests', async () => {
    await t.expectError(t.rpc(runner, 'mx_create_request', newRequest()), 403);
  });

  it('remembers the last location', async () => {
    await create({ p_location: 'Garden bench' });
    expect((await t.rpc(mom, 'mx_me')).user.prefs.lastLocation).toBe('Garden bench');
  });
});

describe('lifecycle', () => {
  it('runs a full delivery with timestamps and history', async () => {
    const r = await create();
    const accepted = (await t.rpc(runner, 'mx_accept', { p_id: r.id, p_eta_minutes: 5 })).request;
    expect(accepted).toMatchObject({ status: 'accepted', runner: { displayName: 'Sam' } });
    expect(Math.abs(accepted.etaAt - accepted.acceptedAt - 5 * 60_000)).toBeLessThan(1000);
    const started = (await t.rpc(runner, 'mx_start', { p_id: r.id })).request;
    expect(started.status).toBe('in_progress');
    expect(started.etaAt).toBe(accepted.etaAt);
    const delivered = (await t.rpc(runner, 'mx_deliver', { p_id: r.id })).request;
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredAt).toBeGreaterThanOrEqual(delivered.startedAt);
    const detail = await t.rpc(mom, 'mx_get_request', { p_id: r.id });
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(['created', 'accepted', 'started', 'delivered']);
  });

  it('refuses to deliver before accepting and starting', async () => {
    const r = await create();
    expect((await t.expectError(t.rpc(runner, 'mx_deliver', { p_id: r.id }), 409)).message).toMatch(/Accept and start/);
    await t.expectError(t.rpc(runner, 'mx_start', { p_id: r.id }), 409);
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    expect((await t.expectError(t.rpc(runner, 'mx_deliver', { p_id: r.id }), 409)).message).toMatch(/Start the delivery/);
  });

  it('does not let Mom perform runner actions', async () => {
    const r = await create();
    for (const fn of ['mx_accept', 'mx_decline', 'mx_start', 'mx_deliver']) await t.expectError(t.rpc(mom, fn, { p_id: r.id }), 403);
    await t.expectError(t.rpc(mom, 'mx_set_eta', { p_id: r.id, p_eta_minutes: 5 }), 403);
  });

  it('treats a repeated action by the same person as already done', async () => {
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    expect((await t.rpc(runner, 'mx_accept', { p_id: r.id })).alreadyApplied).toBe(true);
  });

  it('keeps finished requests final and returns the latest state on conflict', async () => {
    const r = await create();
    await t.rpc(runner, 'mx_decline', { p_id: r.id, p_reason: 'Out of glasses' });
    const err = await t.expectError(t.rpc(mom, 'mx_cancel', { p_id: r.id }), 409);
    expect(err.message).toBe('This request was declined.');
    expect(JSON.parse(err.detail!).request.status).toBe('declined');
    await t.expectError(t.rpc(mom, 'mx_edit_request', { p_id: r.id, p_title: 'Tea' }), 409);
  });

  it('reports a clear conflict when Mom cancels before the runner accepts', async () => {
    const r = await create();
    await t.rpc(mom, 'mx_cancel', { p_id: r.id });
    expect((await t.expectError(t.rpc(runner, 'mx_accept', { p_id: r.id }), 409)).message).toBe('This request was cancelled.');
  });

  it('lets the runner cancel an accepted request with a reason, but decline (not cancel) a pending one', async () => {
    const r = await create();
    await t.expectError(t.rpc(runner, 'mx_cancel', { p_id: r.id }), 409);
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    const res = await t.rpc(runner, 'mx_cancel', { p_id: r.id, p_reason: '  We   ran out ' });
    expect(res.request).toMatchObject({ status: 'cancelled', cancelReason: 'We ran out', cancelledBy: { displayName: 'Sam' } });
  });

  it('lets Mom cancel until the delivery arrives', async () => {
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    await t.rpc(runner, 'mx_start', { p_id: r.id });
    expect((await t.rpc(mom, 'mx_cancel', { p_id: r.id })).request.status).toBe('cancelled');
  });

  it('keeps an accepted request with the runner who took it', async () => {
    const other = await t.member('alex', 'Alex', 'runner');
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    expect((await t.expectError(t.rpc(other, 'mx_accept', { p_id: r.id }), 409)).message).toBe('Already accepted by Sam.');
    expect((await t.expectError(t.rpc(other, 'mx_start', { p_id: r.id }), 403)).message).toBe('Sam is handling this request.');
  });

  it('validates ETA values', async () => {
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    await t.expectError(t.rpc(runner, 'mx_set_eta', { p_id: r.id, p_eta_minutes: 0 }), 400);
    await t.expectError(t.rpc(runner, 'mx_set_eta', { p_id: r.id, p_eta_minutes: 999 }), 400);
    expect((await t.rpc(runner, 'mx_set_eta', { p_id: r.id, p_eta_minutes: 7 })).request.etaAt).toBeTypeOf('number');
  });

  it('stops the runner acting on details that changed since they looked', async () => {
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    await t.rpc(mom, 'mx_edit_request', { p_id: r.id, p_title: 'My medicine' });
    const err = await t.expectError(t.rpc(runner, 'mx_start', { p_id: r.id, p_seen_details_at: 0 }), 409);
    expect(err.hint).toBe('details_changed');
    const latest = JSON.parse(err.detail!).request as DeliveryRequest;
    expect(latest.title).toBe('My medicine');
    // Having seen the change, the runner can go ahead.
    expect((await t.rpc(runner, 'mx_start', { p_id: r.id, p_seen_details_at: latest.detailsUpdatedAt })).request.status).toBe('in_progress');
  });

  it('stops two of Mom’s devices overwriting each other’s edits', async () => {
    const r = await create();
    await t.rpc(mom, 'mx_edit_request', { p_id: r.id, p_location: 'Kitchen', p_seen_details_at: 0 });
    await t.expectError(t.rpc(mom, 'mx_edit_request', { p_id: r.id, p_location: 'Upstairs', p_seen_details_at: 0 }), 409);
  });
});

describe('privacy', () => {
  it('hides one requester’s requests from another', async () => {
    const gran = await t.member('gran', 'Gran', 'mom');
    const r = await create();
    await t.expectError(t.rpc(gran, 'mx_get_request', { p_id: r.id }), 404);
    await t.expectError(t.rpc(gran, 'mx_cancel', { p_id: r.id }), 404);
    await t.expectError(t.rpc(gran, 'mx_edit_request', { p_id: r.id, p_title: 'x' }), 404);
    expect((await t.rpc(gran, 'mx_list_active')).requests).toHaveLength(0);
    expect((await t.rpc(gran, 'mx_activity')).events).toHaveLength(0);
  });

  it('limits what live updates can see with row-level security', async () => {
    const gran = await t.member('gran', 'Gran', 'mom');
    await create();
    const count = (who: Who, table: string) => t.as<number>(who, `select count(*)::int as result from momexpress.${table}`);
    expect(await count(gran, 'requests')).toBe(0);
    expect(await count(gran, 'request_events')).toBe(0);
    expect(await count(mom, 'requests')).toBe(1);
    expect(await count(runner, 'requests')).toBe(1);
    expect(await count(runner, 'request_events')).toBe(1);
    expect(await count(mom, 'notifications')).toBe(1); // her "Request sent"
    expect(await count(runner, 'notifications')).toBe(1); // "New request"
    await expect(count(mom, 'push_subscriptions')).rejects.toThrow(/permission denied/);
    await expect(count(mom, 'members')).rejects.toThrow(/permission denied/);
  });

  it('cannot write to tables directly', async () => {
    const r = await create();
    await expect(t.as(mom, `update momexpress.requests set status = 'delivered' where id = ${r.id}`)).rejects.toThrow(/permission denied/);
    await expect(t.as(runner, `delete from momexpress.requests where id = ${r.id}`)).rejects.toThrow(/permission denied/);
  });

  it('keeps finished delivery records unchangeable even for the database', async () => {
    const r = await create();
    await t.rpc(mom, 'mx_cancel', { p_id: r.id });
    const attempt = async (sql: string, params: unknown[] = []) => {
      await t.db.exec('savepoint attempt');
      try {
        await t.db.query(sql, params);
      } finally {
        await t.db.exec('rollback to savepoint attempt');
      }
    };
    await expect(attempt(`update momexpress.requests set status = 'pending' where id = $1`, [r.id])).rejects.toThrow(/cannot be changed/);
    await expect(attempt(`update momexpress.request_events set type = 'x'`)).rejects.toThrow(/append-only/);
  });
});

describe('editing', () => {
  it('tells the runner what changed', async () => {
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    const res = await t.rpc(mom, 'mx_edit_request', { p_id: r.id, p_location: 'Kitchen', p_priority: 'urgent' });
    expect(res.request).toMatchObject({ location: 'Kitchen', priority: 'urgent', description: 'Cold, please' });
    expect(res.request.detailsUpdatedAt).toBeTypeOf('number');
    const [latest] = await notificationsOf(runner);
    expect(latest).toMatchObject({ type: 'details_updated', title: 'Mom updated a request' });
    expect(latest.body).toBe('“Glass of water”: deliver to Kitchen · priority Urgent');
  });

  it('ignores edits that change nothing', async () => {
    const r = await create();
    expect((await t.rpc(mom, 'mx_edit_request', { p_id: r.id, p_title: 'Glass of water' })).alreadyApplied).toBe(true);
  });

  it('does not let the runner edit details', async () => {
    const r = await create();
    await t.expectError(t.rpc(runner, 'mx_edit_request', { p_id: r.id, p_title: 'Nothing' }), 403);
  });
});

describe('history and stats', () => {
  it('lists finished requests with filters and pages', async () => {
    const a = await create({ p_title: 'A' });
    const b = await create({ p_title: 'B' });
    const c = await create({ p_title: 'C' });
    await create({ p_title: 'Still pending' });
    await t.rpc(runner, 'mx_accept', { p_id: a.id });
    await t.rpc(runner, 'mx_start', { p_id: a.id });
    await t.rpc(runner, 'mx_deliver', { p_id: a.id });
    await t.rpc(runner, 'mx_decline', { p_id: b.id });
    await t.rpc(mom, 'mx_cancel', { p_id: c.id });

    const titles = (res: { requests: DeliveryRequest[] }) => res.requests.map((r) => r.title);
    expect(titles(await t.rpc(mom, 'mx_list_history'))).toEqual(['C', 'B', 'A']);
    expect(titles(await t.rpc(runner, 'mx_list_history', { p_status: 'delivered' }))).toEqual(['A']);
    const page1 = await t.rpc(mom, 'mx_list_history', { p_limit: 2 });
    expect(titles(page1)).toEqual(['C', 'B']);
    const page2 = await t.rpc(mom, 'mx_list_history', { p_limit: 2, p_before: page1.nextCursor });
    expect(titles(page2)).toEqual(['A']);
    expect(page2.nextCursor).toBeNull();

    const stats = await t.rpc(runner, 'mx_stats', { p_since: Date.now() - 60_000 });
    expect(stats.deliveredToday).toBe(1);
  });
});

describe('notifications', () => {
  it('notifies the right people at each step', async () => {
    const r = await create({ p_priority: 'urgent' });
    expect((await notificationsOf(runner))[0]).toMatchObject({ type: 'new_request', title: 'Urgent request from Mom', body: 'Glass of water · Bedroom' });

    await t.rpc(runner, 'mx_accept', { p_id: r.id, p_eta_minutes: 5 });
    await t.rpc(runner, 'mx_set_eta', { p_id: r.id, p_eta_minutes: 6 }); // small change: no notification
    await t.rpc(runner, 'mx_set_eta', { p_id: r.id, p_eta_minutes: 15 }); // big change: notify
    await t.rpc(runner, 'mx_start', { p_id: r.id });
    await t.rpc(runner, 'mx_deliver', { p_id: r.id });

    const momList = await t.rpc(mom, 'mx_notifications');
    expect(momList.notifications.map((n: { type: string }) => n.type)).toEqual(['delivered', 'started', 'eta_updated', 'accepted', 'submitted']);
    expect(momList.unreadCount).toBe(5);
    // Mom's app is in Arabic, and so is everything she's told.
    expect(momList.notifications.map((n: { title: string }) => n.title)).toEqual([
      'وصل طلبك ✓',
      'طلبك في الطريق إليك',
      'تغيّر وقت الوصول',
      'Sam وافق على طلبك',
      'تم إرسال طلبك',
    ]);
    expect(momList.notifications[1].body).toMatch(/^«Glass of water» · يصل خلال حوالي ١[٤٥] دقيقة$/);
    expect(momList.notifications[3].body).toBe('«Glass of water» · يصل خلال حوالي ٥ دقائق');
    expect(momList.notifications[0].body).toBe('«Glass of water»');

    expect((await t.rpc(mom, 'mx_mark_read', { p_ids: [momList.notifications[0].id] })).unreadCount).toBe(4);
    expect((await t.rpc(mom, 'mx_mark_read', { p_request_id: r.id })).unreadCount).toBe(0);
    expect((await t.rpc(runner, 'mx_mark_read', { p_all: true })).unreadCount).toBe(0);
  });

  it('pages through older notifications', async () => {
    for (let i = 0; i < 5; i++) await create({ p_title: `Thing ${i}` });
    const page1 = await t.rpc(runner, 'mx_notifications', { p_limit: 3 });
    expect(page1.notifications).toHaveLength(3);
    const page2 = await t.rpc(runner, 'mx_notifications', { p_limit: 3, p_before: page1.nextCursor });
    expect(page2.notifications.map((n: { body: string }) => n.body)).toEqual(['Thing 1 · Bedroom', 'Thing 0 · Bedroom']);
    expect(page2.nextCursor).toBeNull();
  });

  it('tells Mom in Arabic when a request is declined or cancelled, with the reason', async () => {
    const a = await create({ p_title: 'شاي' });
    await t.rpc(runner, 'mx_decline', { p_id: a.id, p_reason: 'لا يوجد' });
    expect((await notificationsOf(mom))[0]).toMatchObject({ type: 'declined', title: 'Sam لا يستطيع إحضاره الآن', body: '«شاي» · لا يوجد' });

    const b = await create({ p_title: 'دوائي' });
    await t.rpc(runner, 'mx_accept', { p_id: b.id });
    expect((await notificationsOf(mom))[0]).toMatchObject({ type: 'accepted', body: '«دوائي»' });
    await t.rpc(runner, 'mx_cancel', { p_id: b.id, p_reason: 'انتهى' });
    expect((await notificationsOf(mom))[0]).toMatchObject({ type: 'cancelled', title: 'Sam ألغى الطلب', body: '«دوائي» · انتهى' });
  });

  it('writes Arabic minutes the Arabic way', async () => {
    const minutes = async (n: number) => (await t.db.query<{ m: string }>('select momexpress.ar_minutes($1) as m', [n])).rows[0].m;
    expect([await minutes(1), await minutes(2), await minutes(3), await minutes(10), await minutes(11), await minutes(25)]).toEqual([
      'دقيقة',
      'دقيقتين',
      '٣ دقائق',
      '١٠ دقائق',
      '١١ دقيقة',
      '٢٥ دقيقة',
    ]);
  });

  it('tells the runner when Mom cancels', async () => {
    const r = await create();
    await t.rpc(mom, 'mx_cancel', { p_id: r.id, p_reason: 'Found it myself' });
    expect((await notificationsOf(runner))[0]).toMatchObject({ type: 'cancelled', body: '“Glass of water” is no longer needed: Found it myself' });
  });

  it('cannot mark someone else’s notifications as read', async () => {
    await create();
    const [note] = await notificationsOf(runner);
    await t.rpc(mom, 'mx_mark_read', { p_ids: [note.id] });
    expect(await t.rpc(runner, 'mx_unread_count')).toBe(1);
  });
});

describe('push notifications', () => {
  const subscribe = (who: Who, endpoint: string) =>
    t.rpc(who, 'mx_push_subscribe', { p_endpoint: endpoint, p_p256dh: 'BPk', p_auth: 'auth', p_user_agent: 'test' });
  const service = async <T = any>(fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    await t.db.exec('savepoint service; set local role service_role');
    try {
      const res = await t.db.query<{ result: T }>(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as result`, names.map((n) => args[n]));
      await t.db.exec('reset role; release savepoint service');
      return res.rows[0].result;
    } catch (err) {
      await t.db.exec('rollback to savepoint service; reset role');
      throw err;
    }
  };

  beforeEach(async () => {
    await t.db.query(`insert into momexpress.settings (key, value) values ('push_function_url', 'https://example.supabase.co/functions/v1/mx-push')`);
  });

  it('asks the push function to deliver, once, with a link to the request', async () => {
    await subscribe(mom, 'https://push.example/mom-phone');
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id, p_eta_minutes: 3 });
    const calls = (await t.db.query<{ url: string; body: { notificationId: number } }>('select url, body from net.calls')).rows;
    // "Request sent" is off by default for push; the runner has no devices.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.supabase.co/functions/v1/mx-push');

    const job = await service('mx_push_claim', { p_notification_id: calls[0].body.notificationId });
    expect(job.payload).toMatchObject({ type: 'accepted', url: `/requests/${r.id}`, tag: `request-${r.id}`, badgeCount: 2 });
    expect(job.subscriptions).toEqual([expect.objectContaining({ endpoint: 'https://push.example/mom-phone' })]);
    expect(await service('mx_push_claim', { p_notification_id: calls[0].body.notificationId })).toBeNull();
  });

  it('respects notification preferences', async () => {
    await subscribe(mom, 'https://push.example/mom-phone');
    await t.rpc(mom, 'mx_update_me', { p_prefs: { push: { accepted: false } } });
    const r = await create();
    await t.rpc(runner, 'mx_accept', { p_id: r.id });
    expect((await t.db.query('select * from net.calls')).rows).toHaveLength(0);
    expect((await notificationsOf(mom))[0].type).toBe('accepted'); // still recorded in the app
  });

  it('stops pushing to a device once its sign-in session has ended', async () => {
    await subscribe(runner, 'https://push.example/tablet');
    await t.db.query('delete from auth.sessions where id = $1', [runner.sessionId]);
    await create();
    const [call] = (await t.db.query<{ body: { notificationId: number } }>('select body from net.calls')).rows;
    const job = await service('mx_push_claim', { p_notification_id: call.body.notificationId });
    expect(job.subscriptions).toEqual([]);
  });

  it('forgets subscriptions the push service reports as gone', async () => {
    await subscribe(runner, 'https://push.example/old');
    const [sub] = (await service<{ subscriptions: { id: number }[] }>('mx_push_targets', { p_user: runner.userId })).subscriptions;
    await service('mx_push_report', { p_results: JSON.stringify([{ id: sub.id, gone: true }]) });
    expect((await t.rpc(runner, 'mx_push_status', { p_endpoint: 'https://push.example/old' })).subscribed).toBe(false);
  });

  it('only accepts HTTPS push endpoints', async () => {
    await t.expectError(subscribe(mom, 'http://push.example/x'), 400);
  });

  it('keeps one VAPID key pair even if two first uses race', async () => {
    const first = await service('mx_push_store_vapid', { p_public: 'pub-1', p_private: 'priv-1' });
    const second = await service('mx_push_store_vapid', { p_public: 'pub-2', p_private: 'priv-2' });
    expect(second.publicKey).toBe(first.publicKey);
    expect((await t.rpc(mom, 'mx_me')).push.publicKey).toBe('pub-1');
  });
});

describe('setup', () => {
  it('publishes request history and notifications for live updates', async () => {
    const rows = (await t.db.query<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'momexpress' order by 1`,
    )).rows;
    expect(rows.map((r) => r.tablename)).toEqual(['notifications', 'request_events']);
  });

  it('creates accounts that can sign in with their username', async () => {
    const row = (await t.db.query<{ email: string; ok: boolean }>(
      `select email, encrypted_password = extensions.crypt('password-123', encrypted_password) as ok from auth.users where id = $1`,
      [mom.userId],
    )).rows[0];
    expect(row).toEqual({ email: 'mom@momexpress.invalid', ok: true });
  });
});
