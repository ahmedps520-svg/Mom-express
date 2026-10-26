import type { ApiErrorBody, DeliveryRequest } from '../../../shared/types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
    readonly request?: DeliveryRequest,
  ) {
    super(message);
  }

  /** The server was never reached, so nothing was saved. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

type Listener = () => void;
let onUnauthenticated: Listener = () => {};

/** Called when the server says the session has ended, so the app can sign out. */
export function setUnauthenticatedHandler(fn: Listener): void {
  onUnauthenticated = fn;
}

const TIMEOUT_MS = 15_000;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(
      0,
      'network',
      navigator.onLine ? 'Couldn’t reach MomExpress. Please try again.' : 'You’re offline. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
  }

  let data: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 401 && path !== '/api/auth/login') onUnauthenticated();
    // A proxy or gateway error page (no JSON body) means the server wasn't
    // really reached, so treat it like being offline: nothing was saved.
    if (!err && res.status >= 502) throw new ApiError(0, 'network', 'MomExpress is unavailable right now. Please try again shortly.');
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.fields ?? {},
      (data as ApiErrorBody | null)?.request,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};
