import fs from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { MeResponse, RequestListResponse } from '../shared/types.js';
import {
  changePasswordSchema,
  createRequestSchema,
  etaSchema,
  loginSchema,
  markReadSchema,
  optionalEtaSchema,
  pushSubscriptionSchema,
  reasonSchema,
  updateMeSchema,
  updateRequestSchema,
} from '../shared/validation.js';
import { AttemptLimiter, dummyPasswordHash, SESSION_COOKIE, SessionStore, verifyPassword } from './auth.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { errorHandler, HttpError, parseBody, parseId } from './http.js';
import { Notifier } from './notifications.js';
import { PushService, type PushSender } from './push.js';
import { LiveHub } from './realtime.js';
import { RequestService } from './requests.js';
import { toPublicUser, UserStore, type UserRow } from './users.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: { user: UserRow; sessionId: string };
  }
}

export interface AppDeps {
  config: Config;
  db: DB;
  pushSender?: PushSender;
}

export function createApp({ config, db, pushSender }: AppDeps) {
  const users = new UserStore(db);
  const sessions = new SessionStore(db, config.sessionDays * 24 * 60 * 60_000);
  const hub = new LiveHub();
  const push = new PushService(db, config.vapid.subject, config.vapid, pushSender);
  const notifier = new Notifier(db, users, hub, push);
  const requests = new RequestService(db, users, hub, notifier);
  const loginLimiter = new AttemptLimiter(10, 15 * 60_000);
  const buildId = readBuildId(config.webDir);
  // Live streams outlast the request that opened them, so recheck their
  // sessions now and then (e.g. after an account is disabled from the CLI).
  const pruneTimer = setInterval(() => hub.prune((id) => sessions.isValid(id)), 60_000);
  pruneTimer.unref();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'worker-src': ["'self'"],
          'manifest-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: false,
    }),
  );
  // The live event stream must not be buffered by compression.
  app.use(compression({ filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res) }));

  // ------------------------------------------------------------- API basics

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '32kb' }));

  // State-changing requests must be JSON from this app's own origin. Browsers
  // can't send cross-site JSON without permission, so this blocks CSRF.
  api.use((req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (!req.is('application/json')) return next(new HttpError(415, 'unsupported_media_type', 'Requests must be sent as JSON.'));
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}` && !config.allowedOrigins.includes(origin)) {
      return next(new HttpError(403, 'bad_origin', 'This request came from an unexpected place.'));
    }
    next();
  });

  // Identify the signed-in person from their session cookie.
  api.use((req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return next();
    const found = sessions.touch(token);
    if (!found) {
      clearSessionCookie(req, res);
      return next();
    }
    const user = users.byId(found.session.user_id);
    if (!user || user.disabled_at) {
      sessions.destroy(found.session.id);
      clearSessionCookie(req, res);
      return next();
    }
    req.auth = { user, sessionId: found.session.id };
    if (found.renewed) setSessionCookie(req, res, token, found.session.expires_at);
    next();
  });

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, 'unauthenticated', 'Please sign in to continue.'));
    next();
  };
  const me = (req: Request) => req.auth!.user;

  const meResponse = (user: UserRow): MeResponse => ({
    user: toPublicUser(user),
    serverTime: Date.now(),
    buildId,
    push: { publicKey: push.publicKey },
  });

  function setSessionCookie(req: Request, res: Response, token: string, expiresAt: number) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure === 'auto' ? req.secure : config.cookieSecure,
      path: '/',
      expires: new Date(expiresAt),
    });
  }
  function clearSessionCookie(req: Request, res: Response) {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure === 'auto' ? req.secure : config.cookieSecure,
      path: '/',
    });
  }

  api.get('/health', (_req, res) => {
    res.json({ ok: true, buildId });
  });

  // ------------------------------------------------------------- auth

  api.post('/auth/login', async (req, res) => {
    const { username, password } = parseBody(loginSchema, req.body);
    const ipKey = `ip:${req.ip}`;
    const userKey = `user:${username.toLowerCase()}`;
    const wait = Math.max(loginLimiter.retryAfterMs(ipKey), loginLimiter.retryAfterMs(userKey));
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, 'too_many_attempts', `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60_000)} min.`);
    }
    const user = users.byUsername(username);
    const valid = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !valid || user.disabled_at) {
      loginLimiter.fail(ipKey);
      loginLimiter.fail(userKey);
      throw new HttpError(401, 'invalid_credentials', 'That username and password don’t match.');
    }
    loginLimiter.reset(userKey);
    const session = sessions.create(user.id, req.get('user-agent'));
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json(meResponse(user));
  });

  api.post('/auth/logout', (req, res) => {
    if (req.auth) {
      sessions.destroy(req.auth.sessionId); // also removes this device's push subscriptions
      hub.closeSession(req.auth.sessionId);
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  api.use(requireAuth);

  // ------------------------------------------------------------- profile

  api.get('/me', (req, res) => {
    res.json(meResponse(me(req)));
  });

  api.patch('/me', (req, res) => {
    const input = parseBody(updateMeSchema, req.body);
    const updated = users.update(me(req).id, input);
    const publicUser = toPublicUser(updated);
    hub.sendToUser(updated.id, { type: 'me', user: publicUser });
    res.json({ user: publicUser });
  });

  api.post('/me/password', async (req, res) => {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
    const user = me(req);
    const key = `user:${user.username.toLowerCase()}`;
    if (loginLimiter.retryAfterMs(key) > 0) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      loginLimiter.fail(key);
      throw new HttpError(400, 'validation_failed', 'Your current password isn’t right.', {
        fields: { currentPassword: 'Your current password isn’t right.' },
      });
    }
    await users.setPassword(user.id, newPassword);
    // Sign out every other device, keeping this one.
    sessions.destroyAllForUser(user.id, req.auth!.sessionId);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- requests

  api.get('/requests', (req, res) => {
    const scope = req.query.scope === 'history' ? 'history' : 'active';
    if (scope === 'active') {
      res.json({ requests: requests.listActive(me(req)), nextCursor: null, serverTime: Date.now() } satisfies RequestListResponse);
      return;
    }
    const status = typeof req.query.status === 'string' && ['delivered', 'declined', 'cancelled'].includes(req.query.status)
      ? (req.query.status as 'delivered' | 'declined' | 'cancelled')
      : undefined;
    const limit = clampInt(req.query.limit, 1, 100, 30);
    const before = req.query.before ? parseId(req.query.before) : undefined;
    const page = requests.listHistory(me(req), { status, before, limit });
    res.json({ ...page, serverTime: Date.now() } satisfies RequestListResponse);
  });

  api.post('/requests', (req, res) => {
    const input = parseBody(createRequestSchema, req.body);
    const result = requests.create(me(req), input);
    res.status(result.created ? 201 : 200).json(result);
  });

  api.get('/requests/:id', (req, res) => {
    const id = parseId(req.params.id);
    const request = requests.getVisible(me(req), id);
    res.json({ request, events: requests.events(me(req), id), serverTime: Date.now() });
  });

  api.patch('/requests/:id', (req, res) => {
    res.json(requests.edit(me(req), parseId(req.params.id), parseBody(updateRequestSchema, req.body)));
  });

  api.post('/requests/:id/accept', (req, res) => {
    const { etaMinutes } = parseBody(optionalEtaSchema, req.body);
    res.json(requests.accept(me(req), parseId(req.params.id), etaMinutes));
  });

  api.post('/requests/:id/decline', (req, res) => {
    const { reason } = parseBody(reasonSchema, req.body);
    res.json(requests.decline(me(req), parseId(req.params.id), reason));
  });

  api.post('/requests/:id/start', (req, res) => {
    const { etaMinutes } = parseBody(optionalEtaSchema, req.body);
    res.json(requests.start(me(req), parseId(req.params.id), etaMinutes));
  });

  api.post('/requests/:id/eta', (req, res) => {
    const { etaMinutes } = parseBody(etaSchema, req.body);
    res.json(requests.setEta(me(req), parseId(req.params.id), etaMinutes));
  });

  api.post('/requests/:id/deliver', (req, res) => {
    res.json(requests.deliver(me(req), parseId(req.params.id)));
  });

  api.post('/requests/:id/cancel', (req, res) => {
    const { reason } = parseBody(reasonSchema, req.body);
    res.json(requests.cancel(me(req), parseId(req.params.id), reason));
  });

  api.get('/activity', (req, res) => {
    res.json({ events: requests.recentActivity(me(req), clampInt(req.query.limit, 1, 50, 20)) });
  });

  api.get('/stats', (req, res) => {
    const since = clampInt(req.query.since, 0, Number.MAX_SAFE_INTEGER, Date.now() - 24 * 60 * 60_000);
    res.json(requests.stats(me(req), since));
  });

  // ------------------------------------------------------------- notifications

  api.get('/notifications', (req, res) => {
    const before = req.query.before ? parseId(req.query.before) : undefined;
    res.json(notifier.list(me(req).id, { limit: clampInt(req.query.limit, 1, 100, 40), before }));
  });

  api.post('/notifications/read', (req, res) => {
    res.json(notifier.markRead(me(req).id, parseBody(markReadSchema, req.body)));
  });

  // ------------------------------------------------------------- push

  api.post('/push/subscribe', (req, res) => {
    const { subscription } = parseBody(pushSubscriptionSchema, req.body);
    push.saveSubscription({
      userId: me(req).id,
      sessionId: req.auth!.sessionId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: req.get('user-agent'),
    });
    res.json({ ok: true });
  });

  api.post('/push/unsubscribe', (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (endpoint) push.removeSubscription(me(req).id, endpoint);
    res.json({ ok: true });
  });

  api.post('/push/status', (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    res.json({ subscribed: endpoint ? push.hasSubscription(me(req).id, endpoint) : false });
  });

  api.post('/push/test', async (req, res) => {
    const user = me(req);
    const outcome = await push.sendToUser(user.id, {
      title: 'MomExpress notifications are on',
      body: user.role === 'runner' ? 'You’ll hear about new requests right away.' : 'You’ll hear when your requests are on the way.',
      url: '/settings',
      tag: 'test',
      type: 'test',
      requestId: null,
      notificationId: null,
      priority: null,
      badgeCount: notifier.unreadCount(user.id),
    });
    res.json(outcome);
  });

  // ------------------------------------------------------------- live events

  api.get('/events', (req, res) => {
    hub.attach(res, me(req).id, req.auth!.sessionId, { type: 'hello', serverTime: Date.now(), buildId });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Unknown API endpoint.')));
  app.use('/api', api);

  // ------------------------------------------------------------- web app

  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(
      express.static(config.webDir, {
        index: false,
        setHeaders(res, filePath) {
          // Hashed build assets never change; everything else must be revalidated
          // so an installed app always picks up new versions.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
          if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
        },
      }),
    );
    const indexHtml = path.join(config.webDir, 'index.html');
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
      if (!req.accepts('html') || path.extname(req.path)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);

  return {
    app,
    hub,
    notifier,
    users,
    sessions,
    push,
    requests,
    close() {
      clearInterval(pruneTimer);
      hub.close();
    },
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readBuildId(webDir: string): string {
  try {
    const { buildId } = JSON.parse(fs.readFileSync(path.join(webDir, 'version.json'), 'utf8')) as { buildId?: string };
    return buildId ?? 'dev';
  } catch {
    return 'dev';
  }
}
