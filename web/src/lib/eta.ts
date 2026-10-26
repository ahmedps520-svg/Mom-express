import type { DeliveryRequest } from '../../../shared/types.js';
import { isActive } from '../../../shared/lifecycle.js';

export type EtaInfo =
  | { kind: 'not-applicable' }
  | { kind: 'awaiting-accept' }
  | { kind: 'not-set' }
  | { kind: 'upcoming'; at: number; minutes: number; underAMinute: boolean; progress: number }
  | { kind: 'passed'; at: number; minutesAgo: number };

/**
 * Works out what to say about the estimated arrival. Everything is computed
 * locally from the stored ETA, so the countdown runs without server updates.
 */
export function etaInfo(request: DeliveryRequest, now: number): EtaInfo {
  if (!isActive(request.status)) return { kind: 'not-applicable' };
  if (request.status === 'pending') return { kind: 'awaiting-accept' };
  if (!request.etaAt) return { kind: 'not-set' };
  const remaining = request.etaAt - now;
  if (remaining <= 0) return { kind: 'passed', at: request.etaAt, minutesAgo: Math.floor(-remaining / 60_000) };
  const total = Math.max(1, request.etaAt - (request.etaSetAt ?? request.etaAt - remaining));
  return {
    kind: 'upcoming',
    at: request.etaAt,
    minutes: Math.ceil(remaining / 60_000),
    underAMinute: remaining < 60_000,
    progress: Math.min(1, Math.max(0, 1 - remaining / total)),
  };
}

/** One short line for request cards. */
export function etaLine(request: DeliveryRequest, now: number, viewer: 'mom' | 'runner'): string {
  const info = etaInfo(request, now);
  switch (info.kind) {
    case 'awaiting-accept':
      return viewer === 'mom' ? 'Waiting for your runner to accept' : 'Waiting for someone to accept';
    case 'not-set':
      return 'ETA not set yet';
    case 'upcoming':
      if (viewer === 'runner') return info.underAMinute ? 'ETA: under a minute' : `ETA: about ${info.minutes} min`;
      return info.underAMinute ? 'Arriving in less than a minute' : `Arriving in about ${info.minutes} min`;
    case 'passed':
      if (viewer === 'runner') return info.minutesAgo < 1 ? 'ETA reached — update it?' : `ETA passed ${info.minutesAgo} min ago — update it?`;
      return 'Estimated time has passed — should be close';
    default:
      return '';
  }
}
