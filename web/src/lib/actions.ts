import type { DeliveryRequest, MutationResponse } from '../../../shared/types.js';
import { api, ApiError } from '../api/client';
import { upsertRequests } from '../store/app';
import { toast } from '../store/toasts';
import { applyMutation } from './sync';

/**
 * Runs a change on a request and reports the real outcome: success only once
 * the server has saved it; otherwise a clear message, and the latest state if
 * someone else changed the request first.
 */
export async function runRequestAction(
  path: string,
  body: unknown,
  success?: { title: string; body?: string },
  method: 'post' | 'patch' = 'post',
): Promise<DeliveryRequest | null> {
  try {
    const result = await (method === 'post' ? api.post<MutationResponse>(path, body) : api.patch<MutationResponse>(path, body));
    const request = applyMutation(result);
    if (success) toast({ kind: 'success', ...success });
    return request;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.request) upsertRequests([err.request]);
      if (err.isNetwork) toast({ kind: 'error', title: 'Not saved', body: err.message });
      else if (err.status === 409) toast({ kind: 'warning', title: 'This request has changed', body: err.message });
      else if (err.status !== 401) toast({ kind: 'error', title: 'Couldn’t do that', body: err.message });
    } else {
      toast({ kind: 'error', title: 'Something went wrong', body: 'Please try again.' });
    }
    return null;
  }
}
