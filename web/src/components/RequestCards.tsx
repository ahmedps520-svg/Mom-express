import { ChevronRight, MapPin, StickyNote, User } from 'lucide-react';
import { Link } from 'react-router';
import type { DeliveryRequest, PublicUser } from '../../../shared/types.js';
import { finishedAt } from '../store/app';
import { firstName, formatDuration, formatTime, waitingFor, dayLabel } from '../lib/format';
import { useServerNow } from '../lib/hooks';
import { EtaText } from './Eta';
import { PriorityBadge } from './PriorityBadge';
import { RequestIcon } from './RequestIcon';
import { RunnerActions } from './RequestActions';
import { StatusPill } from './StatusPill';

/** A request on the runner's dashboard, with the next action right on the card. */
export function RunnerRequestCard({ request, me, fresh }: { request: DeliveryRequest; me: PublicUser; fresh: boolean }) {
  const now = useServerNow(30_000);
  const mine = request.runner?.id === me.id;
  return (
    <article
      className={`card req-card runner-card prio-edge-${request.priority}${fresh ? ' fresh' : ''}${request.status === 'pending' ? ' is-pending' : ''}`}
      aria-label={`${request.title}, ${request.priority} priority, to ${request.location}`}
    >
      <Link to={`/requests/${request.id}`} className="req-card-link">
        <div className="req-card-main">
          <RequestIcon request={request} />
          <div className="grow stack gap-4">
            <div className="row gap-8 between">
              <h3 className="req-title truncate">{request.title}</h3>
              {request.status === 'pending' ? (
                fresh ? <span className="tag-new">New</span> : <span className="meta subtle nowrap">{waitingFor(request.createdAt, now)}</span>
              ) : (
                <StatusPill status={request.status} />
              )}
            </div>
            <div className="row gap-8 wrap">
              <span className="meta strong-meta">
                <MapPin /> {request.location}
              </span>
              <PriorityBadge priority={request.priority} />
              <span className="meta subtle">
                {firstName(request.requester.displayName)} · {formatTime(request.createdAt)}
              </span>
            </div>
          </div>
        </div>
        {(request.description || request.notes) && (
          <div className="req-note">
            <StickyNote aria-hidden="true" />
            <p>
              {request.description}
              {request.description && request.notes ? ' — ' : ''}
              {request.notes && <em>{request.notes}</em>}
            </p>
          </div>
        )}
        {request.status !== 'pending' && (
          <div className="req-card-foot">
            <EtaText request={request} viewer="runner" />
            {!mine && request.runner && (
              <span className="meta">
                <User /> {firstName(request.runner.displayName)} has this
              </span>
            )}
          </div>
        )}
      </Link>
      <RunnerActions request={request} me={me} compact />
    </article>
  );
}

function outcome(request: DeliveryRequest, me: PublicUser): string {
  const runner = request.runner ? firstName(request.runner.displayName) : 'your runner';
  switch (request.status) {
    case 'delivered':
      return `Delivered in ${formatDuration((request.deliveredAt ?? request.updatedAt) - request.createdAt)}${me.role === 'mom' ? ` by ${runner}` : ''}`;
    case 'declined':
      return `${me.role === 'runner' && request.runner?.id === me.id ? 'You declined' : `Declined by ${runner}`}${request.declineReason ? `: ${request.declineReason}` : ''}`;
    case 'cancelled': {
      const by = request.cancelledBy?.id === me.id ? 'you' : request.cancelledBy ? firstName(request.cancelledBy.displayName) : 'someone';
      return `Cancelled by ${by}${request.cancelReason ? `: ${request.cancelReason}` : ''}`;
    }
    default:
      return '';
  }
}

/** A finished request in history lists. */
export function HistoryRow({ request, me }: { request: DeliveryRequest; me: PublicUser }) {
  const done = finishedAt(request);
  return (
    <Link to={`/requests/${request.id}`} className="list-row history-row">
      <RequestIcon request={request} small />
      <div className="grow stack gap-4">
        <div className="row gap-8 between title-row">
          <span className="row-title truncate">{request.title}</span>
          <StatusPill status={request.status} />
        </div>
        <div className="row gap-8 wrap">
          <span className="meta">
            <MapPin /> {request.location}
          </span>
          <PriorityBadge priority={request.priority} />
          <span className="meta subtle">
            {dayLabel(done)}, {formatTime(done)}
          </span>
        </div>
        <span className="row-sub">{outcome(request, me)}</span>
      </div>
      <ChevronRight className="chev" aria-hidden="true" />
    </Link>
  );
}
