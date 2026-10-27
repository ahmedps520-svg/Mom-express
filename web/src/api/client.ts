import { createClient, type PostgrestError } from '@supabase/supabase-js';
import type { DeliveryRequest, ErrorDetail } from '../../../shared/types.js';
import { SUPABASE_KEY, SUPABASE_URL } from '../config';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'mx:auth' },
});

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

  /** The server was never reached (or never answered), so nothing is confirmed. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

type Listener = () => void;
let onUnauthenticated: Listener = () => {};

/** Called when the server says nobody is signed in, so the app can sign out. */
export function setUnauthenticatedHandler(fn: Listener): void {
  onUnauthenticated = fn;
}

export function networkError(): ApiError {
  return new ApiError(
    0,
    'network',
    navigator.onLine ? 'Couldn’t reach MomExpress. Please try again.' : 'You’re offline. Check your connection and try again.',
  );
}

/** Turns an error from a database function into an ApiError the screens can show. */
function toApiError(error: PostgrestError, status: number): ApiError {
  // The app's functions raise SQLSTATE "PTnnn", which the API turns into HTTP
  // status nnn. The hint carries a short code and the detail carries JSON.
  const custom = /^PT(\d{3})$/.exec(error.code ?? '');
  if (custom) {
    let detail: ErrorDetail = {};
    try {
      detail = error.details ? (JSON.parse(error.details) as ErrorDetail) : {};
    } catch {
      detail = {};
    }
    const httpStatus = Number(custom[1]);
    if (httpStatus === 401) onUnauthenticated();
    return new ApiError(httpStatus, error.hint || 'error', error.message, detail.fields ?? {}, detail.request);
  }
  if (status === 0 || status >= 502) {
    return status === 0 ? networkError() : new ApiError(0, 'network', 'MomExpress is unavailable right now. Please try again shortly.');
  }
  if (status === 401 || error.code?.startsWith('PGRST30')) {
    onUnauthenticated();
    return new ApiError(401, 'unauthenticated', 'Please sign in to continue.');
  }
  console.error('Unexpected database error', error);
  return new ApiError(status || 500, 'error', 'Something went wrong. Please try again.');
}

const TIMEOUT_MS = 15_000;

/** Calls one of the app's database functions (public.mx_*). */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { data, error, status } = await supabase.rpc(fn, args).abortSignal(controller.signal);
    if (error) throw toApiError(error, status);
    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw networkError();
  } finally {
    clearTimeout(timer);
  }
}
