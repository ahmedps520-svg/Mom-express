// MomExpress push sender (Supabase Edge Function).
//
// - The database calls this (through pg_net) whenever a notification should
//   go out as a push. It claims the notification, so each push is sent once
//   even if this endpoint is called again; that's also why it needs no secret.
// - The app calls it with { action: "test" } to send a test push to the
//   signed-in person's own devices, and { action: "vapid" } to fetch the public
//   key (generating the key pair on first use and storing it in the database).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

interface Subscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface Payload {
  title: string;
  body: string;
  url: string;
  tag: string;
  type: string;
  requestId: number | null;
  notificationId: number | null;
  priority: string | null;
  badgeCount: number;
}

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
  const { data, error } = await admin.rpc('mx_push_vapid');
  if (error) throw error;
  let keys = data as { publicKey: string | null; privateKey: string | null; subject: string | null };
  if (!keys.publicKey || !keys.privateKey) {
    const generated = webpush.generateVAPIDKeys();
    const stored = await admin.rpc('mx_push_store_vapid', { p_public: generated.publicKey, p_private: generated.privateKey });
    if (stored.error) throw stored.error;
    keys = stored.data;
  }
  return {
    publicKey: keys.publicKey!,
    privateKey: keys.privateKey!,
    // Push services want a way to reach whoever runs the sender.
    subject: keys.subject ?? 'https://github.com/ahmedps520-svg/Mom-express',
  };
}

async function send(subscriptions: Subscription[], payload: Payload) {
  if (subscriptions.length === 0) return { attempted: 0, delivered: 0 };
  const keys = await vapidKeys();
  const urgent = payload.priority === 'urgent' || payload.type === 'new_request';
  const vapidDetails = { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
  const body = JSON.stringify(payload);
  // No Topic header: Apple's push service refuses any push that has one
  // (400 BadWebPushTopic). The notification's tag already replaces older
  // notifications about the same request on the device.
  const options = [
    // Household requests are only useful for a while.
    { vapidDetails, TTL: 60 * 60, urgency: urgent ? 'high' : 'normal', timeout: 10_000 },
    // If a push service objects to the request itself, try once more with only the basics.
    { vapidDetails, TTL: 60 * 60, timeout: 10_000 },
  ] as const;

  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      for (const [attempt, opts] of options.entries()) {
        try {
          await webpush.sendNotification(target, body, opts);
          return { id: sub.id, ok: true };
        } catch (err) {
          const { statusCode: status, body: reason } = err as { statusCode?: number; body?: string };
          console.warn(`push to subscription ${sub.id} failed (attempt ${attempt + 1})`, status ?? (err as Error).message, reason ?? '');
          if (status !== 400 || attempt === options.length - 1) return { id: sub.id, ok: false, gone: status === 404 || status === 410 };
        }
      }
      return { id: sub.id, ok: false };
    }),
  );
  await admin.rpc('mx_push_report', { p_results: results });
  return { attempted: results.length, delivered: results.filter((r) => r.ok).length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { notificationId?: number; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Expected JSON' }, 400);
  }

  try {
    if (typeof body.notificationId === 'number') {
      const { data: job, error } = await admin.rpc('mx_push_claim', { p_notification_id: body.notificationId });
      if (error) throw error;
      if (!job) return json({ attempted: 0, delivered: 0, note: 'nothing to send' });
      return json(await send(job.subscriptions as Subscription[], job.payload as Payload));
    }

    if (body.action === 'vapid') {
      return json({ publicKey: (await vapidKeys()).publicKey });
    }

    if (body.action === 'test') {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: auth } = await admin.auth.getUser(token);
      if (!auth?.user) return json({ error: 'Please sign in to continue.' }, 401);
      const { data: targets, error } = await admin.rpc('mx_push_targets', { p_user: auth.user.id });
      if (error) throw error;
      if (!targets) return json({ error: 'This account isn’t part of MomExpress.' }, 403);
      return json(
        await send(targets.subscriptions as Subscription[], {
          title: 'MomExpress notifications are on',
          body: targets.role === 'runner' ? 'You’ll hear about new requests right away.' : 'You’ll hear when your requests are on the way.',
          url: '/settings',
          tag: 'test',
          type: 'test',
          requestId: null,
          notificationId: null,
          priority: null,
          badgeCount: targets.badgeCount,
        }),
      );
    }

    return json({ error: 'Unknown request' }, 400);
  } catch (err) {
    console.error('mx-push error', err);
    return json({ error: 'Push sending failed' }, 500);
  }
});
