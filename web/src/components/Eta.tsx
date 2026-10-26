import { Clock, Hourglass, TimerReset } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DeliveryRequest } from '../../../shared/types.js';
import { etaInfo, etaLine } from '../lib/eta';
import { formatTime } from '../lib/format';
import { useServerNow } from '../lib/hooks';

/** A compact, live-updating ETA line for cards. */
export function EtaText({ request, viewer }: { request: DeliveryRequest; viewer: 'mom' | 'runner' }) {
  const now = useServerNow(1000);
  const info = etaInfo(request, now);
  if (info.kind === 'not-applicable') return null;
  const Icon = info.kind === 'passed' ? TimerReset : info.kind === 'upcoming' ? Clock : Hourglass;
  return (
    <span className={`eta-text eta-${info.kind}`}>
      <Icon aria-hidden="true" />
      {etaLine(request, now, viewer)}
    </span>
  );
}

const R = 46;
const CIRC = 2 * Math.PI * R;

/** The large countdown on the tracking screen. */
export function EtaPanel({ request, viewer }: { request: DeliveryRequest; viewer: 'mom' | 'runner' }) {
  const now = useServerNow(1000);
  const info = etaInfo(request, now);
  if (info.kind === 'not-applicable' || info.kind === 'awaiting-accept') return null;

  let ringValue = 0;
  let center: ReactNode;
  let headline: string;
  let sub: string;

  if (info.kind === 'upcoming') {
    ringValue = 1 - info.progress;
    center = (
      <>
        <strong>{info.underAMinute ? '<1' : info.minutes}</strong>
        <span>min</span>
      </>
    );
    headline =
      viewer === 'mom'
        ? info.underAMinute
          ? 'Arriving in less than a minute'
          : `Arriving in about ${info.minutes} minute${info.minutes === 1 ? '' : 's'}`
        : info.underAMinute
          ? 'Due in under a minute'
          : `Due in about ${info.minutes} min`;
    sub = `Estimated around ${formatTime(info.at)}. Estimates can change.`;
  } else if (info.kind === 'passed') {
    ringValue = 1;
    center = <TimerReset aria-hidden="true" />;
    headline = viewer === 'mom' ? 'The estimated time has passed' : 'Your ETA has passed';
    sub =
      viewer === 'mom'
        ? `It was estimated for ${formatTime(info.at)}. Your runner may update it.`
        : `It was ${formatTime(info.at)}${info.minutesAgo >= 1 ? `, ${info.minutesAgo} min ago` : ''}. Let ${request.requester.displayName} know with a new ETA.`;
  } else {
    center = <Hourglass aria-hidden="true" />;
    headline = 'ETA not set yet';
    sub = viewer === 'mom' ? 'Your runner will add an estimate soon.' : `Set an ETA so ${request.requester.displayName} knows when to expect it.`;
  }

  return (
    <div className={`eta-panel eta-${info.kind}`} role="timer" aria-live="polite">
      <div className="eta-ring">
        <svg viewBox="0 0 108 108" aria-hidden="true">
          <circle className="eta-ring-track" cx="54" cy="54" r={R} />
          <circle
            className="eta-ring-value"
            cx="54"
            cy="54"
            r={R}
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - ringValue)}
          />
        </svg>
        <div className="eta-ring-center">{center}</div>
      </div>
      <div className="stack gap-4 grow">
        <span className="eta-label">Estimated arrival</span>
        <strong className="eta-headline">{headline}</strong>
        <span className="eta-sub">{sub}</span>
      </div>
    </div>
  );
}
