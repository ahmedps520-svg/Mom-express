import { Ban, Bike, Check, Clock, LoaderCircle, PackageCheck, X } from 'lucide-react';
import { useState } from 'react';
import { can } from '../../../shared/lifecycle.js';
import type { DeliveryRequest, MutationResponse, PublicUser } from '../../../shared/types.js';
import { mx } from '../api/mx';
import { runRequestAction } from '../lib/actions';
import { firstName } from '../lib/format';
import { serverNow } from '../store/app';
import { EtaSheet, ReasonSheet } from './ActionSheets';

type Busy = null | 'accept' | 'decline' | 'start' | 'eta' | 'deliver' | 'cancel';
type Open = null | 'accept' | 'decline' | 'eta' | 'start-eta' | 'cancel';

function Spinner() {
  return <LoaderCircle className="spin" aria-hidden="true" />;
}

/**
 * The runner's buttons for a request: only the actions its current status
 * allows are shown, and each one waits for the server before reporting success.
 */
export function RunnerActions({ request, me, compact = false }: { request: DeliveryRequest; me: PublicUser; compact?: boolean }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [open, setOpen] = useState<Open>(null);
  const actor = { id: me.id, role: me.role };
  const mom = firstName(request.requester.displayName);
  const size = compact ? 'btn-sm' : '';

  const run = async (kind: Exclude<Busy, null>, call: () => Promise<MutationResponse>, success: { title: string; body?: string }) => {
    setBusy(kind);
    const result = await runRequestAction(request, call, success);
    setBusy(null);
    // Leave the sheet open on failure so the runner can retry.
    if (result) setOpen(null);
    return result;
  };

  const accept = (etaMinutes?: number) =>
    run('accept', () => mx.accept(request, etaMinutes), {
      title: 'Request accepted',
      body: `${mom} can see you’re on it${etaMinutes ? ` · ETA ${etaMinutes} min` : ''}.`,
    });

  if (request.status === 'pending' && can('accept', request, actor)) {
    return (
      <>
        <div className={`action-row${compact ? ' compact' : ''}`}>
          <button type="button" className={`btn btn-secondary ${size}`} onClick={() => setOpen('decline')} disabled={busy !== null}>
            <X /> Decline
          </button>
          <button type="button" className={`btn btn-primary grow ${size}`} onClick={() => setOpen('accept')} disabled={busy !== null}>
            {busy === 'accept' ? <Spinner /> : <Check />} Accept
          </button>
        </div>
        <EtaSheet
          open={open === 'accept'}
          onClose={() => setOpen(null)}
          busy={busy === 'accept'}
          title="Accept and set an ETA"
          description={`How long until “${request.title}” reaches ${mom}? Tap a time to accept.`}
          onSubmit={(m) => void accept(m)}
          skipLabel="Accept without an ETA"
          onSkip={() => void accept()}
        />
        <ReasonSheet
          open={open === 'decline'}
          onClose={() => setOpen(null)}
          busy={busy === 'decline'}
          title="Decline this request?"
          description={`${mom} will be told you can’t take “${request.title}” right now.`}
          confirmLabel="Decline request"
          suggestions={['Busy right now', 'We’re out of it', 'Can’t find it', 'Back soon']}
          onSubmit={(reason) =>
            void run('decline', () => mx.decline(request, reason || undefined), { title: 'Request declined', body: `${mom} has been told.` })
          }
        />
      </>
    );
  }

  const assignedToMe = request.runner?.id === me.id;
  if (!assignedToMe || (request.status !== 'accepted' && request.status !== 'in_progress')) return null;

  const started = { title: 'Delivery started', body: `${mom} can see it’s on the way.` };
  const start = (etaMinutes?: number) => run('start', () => mx.start(request, etaMinutes), started);
  // An ETA that has already passed would tell Mom it's late before it has even left.
  const hasFutureEta = request.etaAt !== null && request.etaAt > serverNow();

  return (
    <>
      <div className={`action-row${compact ? ' compact' : ''}`}>
        <button type="button" className={`btn btn-secondary ${size}`} onClick={() => setOpen('eta')} disabled={busy !== null}>
          {busy === 'eta' ? <Spinner /> : <Clock />} {request.etaAt ? 'Update ETA' : 'Set ETA'}
        </button>
        {request.status === 'accepted' ? (
          <button
            type="button"
            className={`btn btn-primary grow ${size}`}
            onClick={() => (hasFutureEta ? void start() : setOpen('start-eta'))}
            disabled={busy !== null}
          >
            {busy === 'start' ? <Spinner /> : <Bike />} Start delivery
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn-success grow ${size}`}
            onClick={() => void run('deliver', () => mx.deliver(request), { title: 'Delivered!', body: `Nice work. ${mom} has been told.` })}
            disabled={busy !== null}
          >
            {busy === 'deliver' ? <Spinner /> : <PackageCheck />} Mark delivered
          </button>
        )}
      </div>
      {!compact && (
        <button type="button" className="btn btn-ghost btn-sm cant-complete" onClick={() => setOpen('cancel')} disabled={busy !== null}>
          <Ban /> Can’t complete this
        </button>
      )}

      <EtaSheet
        open={open === 'eta'}
        onClose={() => setOpen(null)}
        busy={busy === 'eta'}
        title={request.etaAt ? 'Update the ETA' : 'Set an ETA'}
        description={`${mom} will see the new estimate straight away.`}
        onSubmit={(m) => void run('eta', () => mx.setEta(request, m), { title: 'ETA updated', body: `About ${m} min.` })}
      />
      <EtaSheet
        open={open === 'start-eta'}
        onClose={() => setOpen(null)}
        busy={busy === 'start'}
        title="Start the delivery"
        description={
          request.etaAt
            ? `The ETA you set has passed. Set a new one so ${mom} knows when to expect it.`
            : `Add an ETA so ${mom} knows when to expect it.`
        }
        onSubmit={(m) => void start(m)}
        skipLabel={request.etaAt ? 'Start and keep the old ETA' : 'Start without an ETA'}
        onSkip={() => void start()}
      />
      <ReasonSheet
        open={open === 'cancel'}
        onClose={() => setOpen(null)}
        busy={busy === 'cancel'}
        title="Can’t complete this delivery?"
        description={`The request will be cancelled and ${mom} will see your reason.`}
        confirmLabel="Cancel delivery"
        suggestions={['We ran out', 'Can’t find it', 'Something came up']}
        onSubmit={(reason) =>
          void run('cancel', () => mx.cancel(request, reason || undefined), { title: 'Delivery cancelled', body: `${mom} has been told.` })
        }
      />
    </>
  );
}
