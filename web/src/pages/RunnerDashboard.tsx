import { ChevronRight, Coffee, Inbox, PackageCheck } from 'lucide-react';
import { Link } from 'react-router';
import type { PublicUser } from '../../../shared/types.js';
import { EmptyState } from '../components/EmptyState';
import { PushPrompt } from '../components/PushPrompt';
import { HistoryRow, RunnerRequestCard } from '../components/RequestCards';
import { CardSkeleton, RowSkeleton } from '../components/Skeletons';
import { EVENT_ICONS, describeEvent } from '../lib/events';
import { firstName, greeting, plural, relativeTime } from '../lib/format';
import { useServerNow, useTitle } from '../lib/hooks';
import { byUrgency, selectActive, selectFinished, useApp } from '../store/app';

function ActivityFeed({ me }: { me: PublicUser }) {
  const activity = useApp((s) => s.activity);
  const loaded = useApp((s) => s.dataLoaded);
  const now = useServerNow(30_000);
  if (!loaded) {
    return (
      <div className="card list">
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  }
  if (activity.length === 0) return <p className="muted small-note">Activity on requests will show up here.</p>;
  return (
    <ol className="card activity-feed">
      {activity.slice(0, 8).map((e) => {
        const Icon = EVENT_ICONS[e.type];
        return (
          <li key={e.id}>
            <Link to={`/requests/${e.requestId}`} className={`activity-item ev-${e.type}`}>
              <span className="timeline-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="grow stack">
                <span className="activity-title truncate">{e.requestTitle}</span>
                <span className="activity-text">{describeEvent(e, me)}</span>
              </span>
              <time className="subtle nowrap" dateTime={new Date(e.createdAt).toISOString()}>
                {relativeTime(e.createdAt, now)}
              </time>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export function RunnerDashboard({ me }: { me: PublicUser }) {
  useTitle('Dashboard');
  const requests = useApp((s) => s.requests);
  const loaded = useApp((s) => s.dataLoaded);
  const fresh = useApp((s) => s.fresh);
  const stats = useApp((s) => s.stats);

  const active = selectActive(requests);
  const pending = active.filter((r) => r.status === 'pending').sort(byUrgency);
  const mine = active.filter((r) => r.status !== 'pending' && r.runner?.id === me.id).sort(byUrgency);
  const others = active.filter((r) => r.status !== 'pending' && r.runner?.id !== me.id).sort(byUrgency);
  const recent = selectFinished(requests).slice(0, 5);
  const urgentCount = pending.filter((r) => r.priority === 'urgent').length;

  const headline = !loaded
    ? 'Loading your requests…'
    : pending.length > 0
      ? `${plural(pending.length, 'request')} waiting${urgentCount ? ` · ${urgentCount} urgent` : ''}`
      : mine.length > 0
        ? `${plural(mine.length, 'delivery', 'deliveries')} in progress`
        : 'All caught up. Nice work!';

  return (
    <div className="page">
      <header className="greeting runner-greeting">
        <div className="grow">
          <p className="greeting-eyebrow">{greeting()},</p>
          <h1 className="greeting-title">{firstName(me.displayName)}</h1>
          <p className={`muted${urgentCount ? ' urgent-text' : ''}`}>{headline}</p>
        </div>
        <dl className="stat-row" aria-label="Today">
          <div className="stat">
            <dt>Waiting</dt>
            <dd>{loaded ? pending.length : '–'}</dd>
          </div>
          <div className="stat">
            <dt>Active</dt>
            <dd>{loaded ? mine.length : '–'}</dd>
          </div>
          <div className="stat">
            <dt>Done today</dt>
            <dd>{stats ? stats.deliveredToday : '–'}</dd>
          </div>
        </dl>
      </header>

      <PushPrompt role="runner" />

      <div className="three-col">
        <div>
          <section className="section" aria-labelledby="new-title">
            <div className="section-head">
              <h2 className="section-title" id="new-title">
                New requests {pending.length > 0 && <span className="count-chip hot">{pending.length}</span>}
              </h2>
            </div>
            {!loaded ? (
              <CardSkeleton />
            ) : pending.length === 0 ? (
              <div className="card">
                <EmptyState icon={Coffee} title="No new requests" compact>
                  You’ll hear a chime when one comes in{me.prefs.sound ? '' : ' (sounds are off in Settings)'}.
                </EmptyState>
              </div>
            ) : (
              <div className="stack gap-12">
                {pending.map((r) => (
                  <RunnerRequestCard key={r.id} request={r} me={me} fresh={!!fresh[r.id]} />
                ))}
              </div>
            )}
          </section>
        </div>

        <div>
          <section className="section" aria-labelledby="active-title">
            <div className="section-head">
              <h2 className="section-title" id="active-title">
                Your deliveries {mine.length > 0 && <span className="count-chip">{mine.length}</span>}
              </h2>
            </div>
            {!loaded ? (
              <CardSkeleton />
            ) : mine.length === 0 ? (
              <div className="card">
                <EmptyState icon={Inbox} title="Nothing in progress" compact>
                  Requests you accept will appear here until they’re delivered.
                </EmptyState>
              </div>
            ) : (
              <div className="stack gap-12">
                {mine.map((r) => (
                  <RunnerRequestCard key={r.id} request={r} me={me} fresh={!!fresh[r.id]} />
                ))}
              </div>
            )}
          </section>

          {others.length > 0 && (
            <section className="section" aria-labelledby="others-title">
              <div className="section-head">
                <h2 className="section-title" id="others-title">
                  Handled by others
                </h2>
              </div>
              <div className="stack gap-12">
                {others.map((r) => (
                  <RunnerRequestCard key={r.id} request={r} me={me} fresh={false} />
                ))}
              </div>
            </section>
          )}
        </div>

        <div>
          <section className="section" aria-labelledby="activity-title">
            <div className="section-head">
              <h2 className="section-title" id="activity-title">
                Recent activity
              </h2>
            </div>
            <ActivityFeed me={me} />
          </section>

          <section className="section" aria-labelledby="done-title">
            <div className="section-head">
              <h2 className="section-title" id="done-title">
                <PackageCheck aria-hidden="true" className="title-icon" /> Recently finished
              </h2>
              {recent.length > 0 && (
                <Link to="/history" className="section-link">
                  History <ChevronRight aria-hidden="true" />
                </Link>
              )}
            </div>
            {loaded && recent.length === 0 ? (
              <p className="muted small-note">Completed deliveries will be listed here.</p>
            ) : (
              <div className="card list">
                {recent.map((r) => (
                  <HistoryRow key={r.id} request={r} me={me} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
