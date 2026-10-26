import { Ban, Bike, Check, CircleX, PackageCheck, Send, ThumbsUp, type LucideIcon } from 'lucide-react';
import type { DeliveryRequest } from '../../../shared/types.js';
import { formatTime } from '../lib/format';

interface Step {
  key: string;
  label: string;
  icon: LucideIcon;
  at: number | null;
  state: 'done' | 'current' | 'upcoming' | 'stopped';
}

function buildSteps(r: DeliveryRequest): Step[] {
  const reached = {
    pending: true,
    accepted: r.acceptedAt !== null,
    in_progress: r.startedAt !== null,
    delivered: r.deliveredAt !== null,
  };
  const base: Omit<Step, 'state'>[] = [
    { key: 'pending', label: 'Sent', icon: Send, at: r.createdAt },
    { key: 'accepted', label: 'Accepted', icon: ThumbsUp, at: r.acceptedAt },
    { key: 'in_progress', label: 'On the way', icon: Bike, at: r.startedAt },
    { key: 'delivered', label: 'Delivered', icon: PackageCheck, at: r.deliveredAt },
  ];

  if (r.status === 'declined' || r.status === 'cancelled') {
    const done = base.filter((s) => reached[s.key as keyof typeof reached]);
    return [
      ...done.map((s) => ({ ...s, state: 'done' as const })),
      {
        key: r.status,
        label: r.status === 'declined' ? 'Declined' : 'Cancelled',
        icon: r.status === 'declined' ? CircleX : Ban,
        at: r.status === 'declined' ? r.declinedAt : r.cancelledAt,
        state: 'stopped',
      },
    ];
  }

  const currentIndex = base.findIndex((s) => s.key === r.status);
  return base.map((s, i) => ({
    ...s,
    state: i < currentIndex || r.status === 'delivered' ? 'done' : i === currentIndex ? 'current' : 'upcoming',
  }));
}

export function ProgressTracker({ request }: { request: DeliveryRequest }) {
  const steps = buildSteps(request);
  return (
    <ol className="tracker" aria-label="Delivery progress">
      {steps.map((step, i) => {
        const Icon = step.state === 'done' && step.key !== 'delivered' ? Check : step.icon;
        return (
          <li key={step.key} className={`tracker-step ${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
            {i > 0 && <span className="tracker-bar" aria-hidden="true" />}
            <span className="tracker-dot" aria-hidden="true">
              <Icon />
            </span>
            <span className="tracker-label">{step.label}</span>
            <span className="tracker-time">{step.at ? formatTime(step.at) : step.state === 'current' ? 'Now' : '—'}</span>
            <span className="sr-only">{step.state === 'done' ? 'completed' : step.state === 'current' ? 'in progress' : step.state === 'stopped' ? 'ended here' : 'not yet'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A thin four-part bar for request cards. */
export function MiniProgress({ request }: { request: DeliveryRequest }) {
  const index = ['pending', 'accepted', 'in_progress', 'delivered'].indexOf(request.status);
  return (
    <div className={`mini-progress status-${request.status}`} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={i < index ? 'filled' : i === index ? 'filled current' : ''} />
      ))}
    </div>
  );
}
