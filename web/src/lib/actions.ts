import type { DeliveryRequest, MutationResponse } from '../../../shared/types.js';
import { ApiError } from '../api/client';
import { upsertRequests } from '../store/app';
import { toast } from '../store/toasts';
import { applyMutation, refreshRequest } from './sync';

/**
 * Runs a change on a request and reports the real outcome: success only once
 * the server has saved it; otherwise a clear message, and the latest state if
 * someone else changed the request first.
 */
export async function runRequestAction(
  request: DeliveryRequest,
  call: () => Promise<MutationResponse>,
  success?: { title: string; body?: string },
): Promise<DeliveryRequest | null> {
  try {
    const updated = applyMutation(await call());
    if (success) toast({ kind: 'success', ...success });
    return updated;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.request) upsertRequests([err.request]);
      if (err.isNetwork) {
        // The change may or may not have reached the server; show whatever it has once we can.
        toast({ kind: 'error', title: 'Not confirmed', body: `${err.message} Check the request before trying again.` });
        void refreshRequest(request.id);
      } else if (err.status === 409) toast({ kind: 'warning', title: 'This request has changed', body: err.message });
      else if (err.status !== 401) toast({ kind: 'error', title: 'Couldn’t do that', body: err.message });
    } else {
      toast({ kind: 'error', title: 'Something went wrong', body: 'Please try again.' });
    }
    return null;
  }
}
