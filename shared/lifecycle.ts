import type { DeliveryRequest, RequestStatus, Role } from './types.js';

// The request lifecycle, in one place. The server enforces these rules; the web
// app uses the same functions to decide which buttons to show.
//
//   pending ──accept──▶ accepted ──start──▶ in_progress ──deliver──▶ delivered
//      │                   │                    │
//      ├─decline─▶ declined│                    │
//      └──────cancel───────┴───────cancel───────┴──▶ cancelled
//
// Mom can cancel any request of hers that hasn't been delivered yet.
// The runner declines pending requests, and can cancel a request they have
// accepted if they can't finish it (always with the reason shown to Mom).

export const ACTIVE_STATUSES: RequestStatus[] = ['pending', 'accepted', 'in_progress'];
export const FINAL_STATUSES: RequestStatus[] = ['delivered', 'declined', 'cancelled'];

export function isActive(status: RequestStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isFinal(status: RequestStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export type RequestAction = 'accept' | 'decline' | 'start' | 'set_eta' | 'deliver' | 'cancel' | 'edit';

export interface Actor {
  id: number;
  role: Role;
}

type RequestFacts = Pick<DeliveryRequest, 'status'> & {
  requester: { id: number };
  runner: { id: number; displayName?: string } | null;
};

export type ActionCheck =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'invalid_state'; message: string };

const allow: ActionCheck = { ok: true };

function forbidden(message: string): ActionCheck {
  return { ok: false, code: 'forbidden', message };
}

function invalidState(message: string): ActionCheck {
  return { ok: false, code: 'invalid_state', message };
}

/** Explains, in plain words, why a request can no longer change. */
export function finalStateMessage(status: RequestStatus): string {
  switch (status) {
    case 'delivered':
      return 'This request has already been delivered.';
    case 'declined':
      return 'This request was declined.';
    case 'cancelled':
      return 'This request was cancelled.';
    default:
      return 'This request can’t be changed right now.';
  }
}

export function checkAction(action: RequestAction, request: RequestFacts, actor: Actor): ActionCheck {
  const { status } = request;
  const isOwner = actor.role === 'mom' && request.requester.id === actor.id;
  const isAssignedRunner = actor.role === 'runner' && request.runner?.id === actor.id;

  if (actor.role === 'mom' && !isOwner) return forbidden('This request belongs to someone else.');

  if (isFinal(status)) return invalidState(finalStateMessage(status));

  switch (action) {
    case 'accept':
    case 'decline':
      if (actor.role !== 'runner') return forbidden('Only the runner can do that.');
      if (status !== 'pending') {
        const who = request.runner?.displayName;
        return invalidState(who ? `Already accepted by ${who}.` : 'This request has already been accepted.');
      }
      return allow;

    case 'start':
      if (actor.role !== 'runner') return forbidden('Only the runner can start a delivery.');
      if (status === 'pending') return invalidState('Accept the request before starting the delivery.');
      if (!isAssignedRunner) return forbidden(`${request.runner?.displayName ?? 'Another runner'} is handling this request.`);
      if (status !== 'accepted') return invalidState('This delivery is already on the way.');
      return allow;

    case 'set_eta':
      if (actor.role !== 'runner') return forbidden('Only the runner can set the ETA.');
      if (status === 'pending') return invalidState('Accept the request before setting an ETA.');
      if (!isAssignedRunner) return forbidden(`${request.runner?.displayName ?? 'Another runner'} is handling this request.`);
      return allow;

    case 'deliver':
      if (actor.role !== 'runner') return forbidden('Only the runner can mark a request as delivered.');
      if (status === 'pending') return invalidState('Accept and start the delivery before marking it delivered.');
      if (!isAssignedRunner) return forbidden(`${request.runner?.displayName ?? 'Another runner'} is handling this request.`);
      if (status === 'accepted') return invalidState('Start the delivery before marking it delivered.');
      return allow;

    case 'cancel':
      if (actor.role === 'mom') return allow;
      if (status === 'pending') return invalidState('Decline the request instead of cancelling it.');
      if (!isAssignedRunner) return forbidden(`${request.runner?.displayName ?? 'Another runner'} is handling this request.`);
      return allow;

    case 'edit':
      if (actor.role !== 'mom') return forbidden('Only the person who asked can edit a request.');
      return allow;
  }
}

export function can(action: RequestAction, request: RequestFacts, actor: Actor): boolean {
  return checkAction(action, request, actor).ok;
}

/** The status an action moves a request to, for actions that change status. */
export const ACTION_TARGET: Partial<Record<RequestAction, RequestStatus>> = {
  accept: 'accepted',
  decline: 'declined',
  start: 'in_progress',
  deliver: 'delivered',
  cancel: 'cancelled',
};

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  in_progress: 'In progress',
  delivered: 'Delivered',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

/** Ordered steps for the progress tracker. */
export const PROGRESS_STEPS: RequestStatus[] = ['pending', 'accepted', 'in_progress', 'delivered'];

export function progressIndex(status: RequestStatus): number {
  return PROGRESS_STEPS.indexOf(status);
}
