import type { Response } from 'express';
import type { LiveEvent } from '../shared/types.js';

interface Client {
  res: Response;
  userId: number;
  sessionId: string;
}

/**
 * Keeps one Server-Sent Events stream per open app window and delivers live
 * events to the right people. Clients refetch on reconnect, so anything sent
 * while a device was offline is picked up then.
 */
export class LiveHub {
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout;

  constructor(heartbeatMs = 20_000) {
    // Regular pings keep proxies from closing idle streams, and let the app
    // notice a connection that died silently (common when a phone sleeps).
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  attach(res: Response, userId: number, sessionId: string, hello: LiveEvent): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const client: Client = { res, userId, sessionId };
    this.clients.add(client);
    this.write(client, hello);
    res.on('close', () => this.clients.delete(client));
  }

  sendToUser(userId: number, event: LiveEvent): void {
    for (const client of this.clients) if (client.userId === userId) this.write(client, event);
  }

  sendToUsers(userIds: Iterable<number>, event: LiveEvent): void {
    const ids = new Set(userIds);
    for (const client of this.clients) if (ids.has(client.userId)) this.write(client, event);
  }

  /** Ends the live streams of a session, e.g. after sign-out. */
  closeSession(sessionId: string): void {
    for (const client of this.clients) {
      if (client.sessionId === sessionId) {
        client.res.end();
        this.clients.delete(client);
      }
    }
  }

  closeUser(userId: number): void {
    for (const client of this.clients) {
      if (client.userId === userId) {
        client.res.end();
        this.clients.delete(client);
      }
    }
  }

  /** Closes streams whose session has ended (signed out, expired, or account disabled). */
  prune(isSessionValid: (sessionId: string) => boolean): void {
    for (const client of this.clients) {
      if (!isSessionValid(client.sessionId)) {
        client.res.end();
        this.clients.delete(client);
      }
    }
  }

  connectionCount(): number {
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }

  private write(client: Client, event: LiveEvent): void {
    client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
