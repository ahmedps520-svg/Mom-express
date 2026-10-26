import {
  ArrowLeft,
  Ban,
  Bike,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  MapPin,
  MessageSquareText,
  PackageSearch,
  Send,
  ThumbsUp,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PRIORITY_LABELS } from '../../../shared/constants.js';
import { isActive } from '../../../shared/lifecycle.js';
import type { DeliveryRequest, PublicUser } from '../../../shared/types.js';
import { ApiError } from '../api/client';
import { Confetti } from '../components/Confetti';
import { EmptyState } from '../components/EmptyState';
import { EtaPanel } from '../components/Eta';
import { PriorityBadge } from '../components/PriorityBadge';
import { ProgressTracker } from '../components/ProgressTracker';
import { MomActions, RunnerActions } from '../components/RequestActions';
import { RequestIcon } from '../components/RequestIcon';
import { CardSkeleton } from '../components/Skeletons';
import { StatusPill } from '../components/StatusPill';
import { EVENT_ICONS, describeEvent } from '../lib/events';
import { firstName, formatDateTime, formatDuration, formatTime, relativeTime } from '../lib/format';
import { useBack, usePrevious, useServerNow, useTitle } from '../lib/hooks';
import { loadRequestDetail, markNotificationsRead } from '../lib/sync';
import { useApp } from '../store/app';

interface Hero {
  icon: LucideIcon;
  title: string;
  text: string;
}

function hero(r: DeliveryRequest, me: PublicUser): Hero {
  const runner = r.runner ? firstName(r.runner.displayName) : null;
  const mom = firstName(r.requester.displayName);
  const isMom = me.role === 'mom';
  const mine = r.runner?.id === me.id;
  switch (r.status) {
    case 'pending':
      return isMom
        ? { icon: Hourglass, title: 'Waiting for your runner', text: 'Your request has been sent. You’ll see it here the moment it’s accepted.' }
        : { icon: Hourglass, title: 'New request', text: `${mom} is waiting for someone to accept this.` };
    case 'accepted':
      return isMom
        ? { icon: ThumbsUp, title: `${runner ?? 'Your runner'} is on it`, text: 'Accepted and getting it ready for you.' }
        : { icon: ThumbsUp, title: mine ? 'You accepted this' : `${runner} accepted this`, text: mine ? `Start the delivery when you head to ${r.location}.` : `${runner} is handling it.` };
    case 'in_progress':
      return isMom
        ? { icon: Bike, title: 'On the way!', text: `${runner ?? 'Your runner'} is bringing it to ${r.location}.` }
        : { icon: Bike, title: mine ? 'You’re on the way' : `${runner} is on the way`, text: `Delivering to ${r.location}.` };
    case 'delivered': {
      const took = formatDuration((r.deliveredAt ?? r.updatedAt) - r.createdAt);
      return isMom
        ? { icon: CircleCheck, title: 'Delivered!', text: `${runner ?? 'Your runner'} delivered it at ${formatTime(r.deliveredAt ?? r.updatedAt)} — ${took} after you asked. Enjoy!` }
        : { icon: CircleCheck, title: 'Delivered', text: `Delivered at ${formatTime(r.deliveredAt ?? r.updatedAt)}, ${took} after ${mom} asked.` };
    }
    case 'declined':
      return {
        icon: CircleX,
        title: 'Request declined',
        text: `${isMom ? `${runner ?? 'Your runner'} couldn’t take this one` : mine ? 'You declined this request' : `${runner} declined this request`}${r.declineReason ? `: “${r.declineReason}”.` : '.'} It won’t be delivered.`,
      };
    case 'cancelled': {
      const byMe = r.cancelledBy?.id === me.id;
      const who = byMe ? 'You' : r.cancelledBy ? firstName(r.cancelledBy.displayName) : 'Someone';
      return {
        icon: Ban,
        title: 'Request cancelled',
        text: `${who} cancelled this request${r.cancelReason ? `: “${r.cancelReason}”.` : '.'} It won’t be delivered.`,
      };
    }
  }
}

export function RequestDetailPage({ me }: { me: PublicUser }) {
  const id = Number(useParams().id);
  const back = useBack();
  const request = useApp((s) => s.requests[id]);
  const events = useApp((s) => s.requestEvents[id]);
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const prevStatus = usePrevious(request?.status);
  const now = useServerNow(30_000);
  useTitle(request ? request.title : 'Request');

  // Load the full history, and reload it after every resync (e.g. after a
  // reconnect) so nothing that happened while offline is missing.
  const lastSyncedAt = useApp((s) => s.lastSyncedAt);
  useEffect(() => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError('We couldn’t find that request.');
      return;
    }
    setError(null);
    loadRequestDetail(id).catch((err) => {
      // If we already have it (e.g. offline), keep showing what we have.
      if (!useApp.getState().requests[id]) setError(err instanceof ApiError ? err.message : 'Couldn’t load this request.');
    });
  }, [id, lastSyncedAt]);

  // Opening a request counts as reading its notifications.
  const unreadForThis = useApp((s) => s.notifications.some((n) => n.requestId === id && !n.readAt));
  useEffect(() => {
    if (unreadForThis) void markNotificationsRead({ requestId: id }).catch(() => {});
  }, [unreadForThis, id]);

  // Celebrate a delivery that happens while this screen is open.
  useEffect(() => {
    if (prevStatus && prevStatus !== 'delivered' && request?.status === 'delivered') setCelebrate(Date.now());
  }, [prevStatus, request?.status]);

  if (!request) {
    return (
      <div className="page narrow">
        <div className="detail-top">
          <button type="button" className="icon-btn" onClick={back} aria-label="Back">
            <ArrowLeft />
          </button>
        </div>
        {error ? (
          <div className="card">
            <EmptyState icon={PackageSearch} title="Request not found" action={<Link className="btn btn-secondary" to="/">Back home</Link>}>
              {error}
            </EmptyState>
          </div>
        ) : (
          <div className="stack gap-12">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        )}
      </div>
    );
  }

  const h = hero(request, me);
  const HeroIcon = h.icon;
  const active = isActive(request.status);
  const viewer = me.role;

  return (
    <div className="page narrow detail-page">
      <Confetti fire={celebrate} />
      <div className="detail-top">
        <button type="button" className="icon-btn" onClick={back} aria-label="Back">
          <ArrowLeft />
        </button>
        <div className="grow">
          <span className="subtle detail-number">Request #{request.id}</span>
        </div>
        <StatusPill status={request.status} />
      </div>

      <section className={`card status-hero hero-${request.status}`} aria-live="polite">
        <div className={`hero-icon${active ? ' live' : ''}`} key={request.status}>
          <HeroIcon aria-hidden="true" />
        </div>
        <div className="stack gap-4 grow">
          <h1 className="hero-title">{h.title}</h1>
          <p className="hero-text">{h.text}</p>
        </div>
      </section>

      {active && request.status !== 'pending' && (
        <section className="card card-pad">
          <EtaPanel request={request} viewer={viewer} />
        </section>
      )}

      <section className="card card-pad">
        <ProgressTracker request={request} />
      </section>

      <section className="card card-pad request-details" aria-labelledby="details-title">
        <div className="row gap-12">
          <RequestIcon request={request} />
          <div className="grow">
            <h2 className="detail-title" id="details-title">
              {request.title}
            </h2>
            <span className="subtle">
              Asked by {request.requester.id === me.id ? 'you' : firstName(request.requester.displayName)} · {formatDateTime(request.createdAt, now)}
            </span>
          </div>
        </div>
        {request.description && <p className="detail-description">{request.description}</p>}
        <dl className="detail-grid">
          <div>
            <dt>
              <MapPin aria-hidden="true" /> Deliver to
            </dt>
            <dd>{request.location}</dd>
          </div>
          <div>
            <dt>
              <Clock aria-hidden="true" /> Priority
            </dt>
            <dd>{request.priority === 'normal' ? PRIORITY_LABELS.normal : <PriorityBadge priority={request.priority} />}</dd>
          </div>
          <div>
            <dt>
              <User aria-hidden="true" /> Runner
            </dt>
            <dd>{request.runner ? (request.runner.id === me.id ? 'You' : request.runner.displayName) : 'Not accepted yet'}</dd>
          </div>
          <div>
            <dt>
              <Send aria-hidden="true" /> Sent
            </dt>
            <dd>{relativeTime(request.createdAt, now)}</dd>
          </div>
        </dl>
        {request.notes && (
          <div className="detail-notes">
            <MessageSquareText aria-hidden="true" />
            <div>
              <strong>Notes for the runner</strong>
              <p>{request.notes}</p>
            </div>
          </div>
        )}
        {request.detailsUpdatedAt && <p className="subtle edited-note">Details updated {relativeTime(request.detailsUpdatedAt, now)}</p>}
      </section>

      <section className={`detail-actions${active ? ' sticky-actions' : ''}`}>
        {me.role === 'mom' ? <MomActions request={request} me={me} /> : <RunnerActions request={request} me={me} />}
      </section>

      <section className="card card-pad" aria-labelledby="timeline-title">
        <h2 className="card-title" id="timeline-title">
          Activity
        </h2>
        {!events ? (
          <div className="stack gap-8" style={{ marginTop: 14 }}>
            <div className="skeleton" style={{ height: 14, width: '70%' }} />
            <div className="skeleton" style={{ height: 14, width: '50%' }} />
          </div>
        ) : (
          <ol className="timeline">
            {[...events].reverse().map((e) => {
              const Icon = EVENT_ICONS[e.type];
              return (
                <li key={e.id} className={`timeline-item ev-${e.type}`}>
                  <span className="timeline-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <div className="grow">
                    <span className="timeline-text">{describeEvent(e, me)}</span>
                    <time className="timeline-time" dateTime={new Date(e.createdAt).toISOString()}>
                      {formatDateTime(e.createdAt, now)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
