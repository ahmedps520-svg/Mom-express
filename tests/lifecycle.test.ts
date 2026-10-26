import { describe, expect, it } from 'vitest';
import { can, checkAction, type RequestAction } from '../shared/lifecycle.js';
import type { RequestStatus } from '../shared/types.js';

const mom = { id: 1, role: 'mom' as const };
const otherMom = { id: 4, role: 'mom' as const };
const runner = { id: 2, role: 'runner' as const };
const otherRunner = { id: 3, role: 'runner' as const };

function request(status: RequestStatus, runnerId: number | null = status === 'pending' ? null : runner.id) {
  return { status, requester: { id: mom.id }, runner: runnerId ? { id: runnerId, displayName: 'Sam' } : null };
}

const ALL: RequestAction[] = ['accept', 'decline', 'start', 'set_eta', 'deliver', 'cancel', 'edit'];
const allowed = (status: RequestStatus, actor: typeof mom | typeof runner) =>
  ALL.filter((a) => can(a, request(status), actor));

describe('request lifecycle', () => {
  it('lets each person do only what the current status allows', () => {
    expect(allowed('pending', mom)).toEqual(['cancel', 'edit']);
    expect(allowed('pending', runner)).toEqual(['accept', 'decline']);
    expect(allowed('accepted', mom)).toEqual(['cancel', 'edit']);
    expect(allowed('accepted', runner)).toEqual(['start', 'set_eta', 'cancel']);
    expect(allowed('in_progress', mom)).toEqual(['cancel', 'edit']);
    expect(allowed('in_progress', runner)).toEqual(['set_eta', 'deliver', 'cancel']);
  });

  it('makes finished requests final for everyone', () => {
    for (const status of ['delivered', 'declined', 'cancelled'] as const) {
      expect(allowed(status, mom)).toEqual([]);
      expect(allowed(status, runner)).toEqual([]);
    }
  });

  it('never allows delivering before accepting and starting', () => {
    expect(checkAction('deliver', request('pending'), runner)).toMatchObject({ ok: false, code: 'invalid_state' });
    expect(checkAction('deliver', request('accepted'), runner)).toMatchObject({ ok: false, code: 'invalid_state' });
    expect(checkAction('deliver', request('in_progress'), runner)).toEqual({ ok: true });
  });

  it('keeps an accepted request with the runner who took it', () => {
    expect(can('start', request('accepted'), otherRunner)).toBe(false);
    expect(can('deliver', request('in_progress'), otherRunner)).toBe(false);
    expect(can('cancel', request('in_progress'), otherRunner)).toBe(false);
    expect(checkAction('accept', request('accepted'), otherRunner)).toMatchObject({ ok: false, message: 'Already accepted by Sam.' });
  });

  it('keeps one requester out of another’s requests', () => {
    for (const action of ALL) expect(can(action, request('pending'), otherMom)).toBe(false);
  });
});
