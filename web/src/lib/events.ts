import { Ban, Bike, CircleCheck, CircleX, Pencil, Send, ThumbsUp, Timer, type LucideIcon } from 'lucide-react';
import type { PublicUser, RequestEvent } from '../../../shared/types.js';
import { firstName, formatTime } from './format';

export const EVENT_ICONS: Record<RequestEvent['type'], LucideIcon> = {
  created: Send,
  accepted: ThumbsUp,
  declined: CircleX,
  started: Bike,
  eta_updated: Timer,
  delivered: CircleCheck,
  cancelled: Ban,
  edited: Pencil,
};

/** A short sentence for a request history entry, e.g. "Sam accepted (ETA 7:42 PM)". */
export function describeEvent(e: RequestEvent, me: PublicUser): string {
  const who = e.actor?.id === me.id ? 'You' : e.actor ? firstName(e.actor.displayName) : 'Someone';
  const etaAt = typeof e.data.etaAt === 'number' ? e.data.etaAt : null;
  const eta = etaAt ? ` (ETA ${formatTime(etaAt)})` : '';
  switch (e.type) {
    case 'created':
      return `${who} sent the request`;
    case 'accepted':
      return `${who} accepted${eta}`;
    case 'declined':
      return `${who} declined${e.data.reason ? `: “${String(e.data.reason)}”` : ''}`;
    case 'started':
      return `${who} started the delivery${eta}`;
    case 'eta_updated':
      return `${who} ${e.data.previousEtaAt ? 'changed' : 'set'} the ETA to ${etaAt ? formatTime(etaAt) : '—'}`;
    case 'delivered':
      return `${who} delivered it`;
    case 'cancelled':
      return `${who} cancelled${e.data.reason ? `: “${String(e.data.reason)}”` : ''}`;
    case 'edited': {
      const changes = Object.keys((e.data.changes as Record<string, unknown>) ?? {});
      const names: Record<string, string> = { title: 'title', description: 'details', location: 'location', priority: 'priority', notes: 'notes' };
      return `${who} updated the ${changes.map((c) => names[c] ?? c).join(', ') || 'details'}`;
    }
  }
}
