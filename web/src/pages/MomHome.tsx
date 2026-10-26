import { ChevronRight, CloudUpload, Cookie, GlassWater, HandHelping, Pill, Plus, Send, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { QUICK_REQUESTS } from '../../../shared/constants.js';
import type { PublicUser } from '../../../shared/types.js';
import { EmptyState } from '../components/EmptyState';
import { PushPrompt } from '../components/PushPrompt';
import { HistoryRow, MomRequestCard } from '../components/RequestCards';
import { CardSkeleton, RowSkeleton } from '../components/Skeletons';
import { firstName, greeting, relativeTime } from '../lib/format';
import { useServerNow, useTitle } from '../lib/hooks';
import { discardOutboxItem, retryOutboxItem } from '../lib/sync';
import { selectActive, selectFinished, useApp, type OutboxItem } from '../store/app';

const QUICK_ICONS = { water: GlassWater, snack: Cookie, help: HandHelping, medicine: Pill };

function OutboxCard({ item }: { item: OutboxItem }) {
  const now = useServerNow(30_000);
  return (
    <div className={`card outbox-card ${item.state}`}>
      <span className="bubble bubble-sm tone-default" aria-hidden="true">
        {item.state === 'failed' ? <TriangleAlert /> : <CloudUpload />}
      </span>
      <div className="grow stack gap-4">
        <div className="row gap-8 between">
          <strong className="truncate">{item.payload.title}</strong>
          <span className={`status-pill ${item.state === 'failed' ? 'status-declined' : 'status-cancelled'}`}>
            <span className="dot" aria-hidden="true" />
            {item.state === 'sending' ? 'Sending…' : item.state === 'failed' ? 'Not sent' : 'Not sent yet'}
          </span>
        </div>
        <span className="muted" style={{ fontSize: 13.5 }}>
          {item.state === 'failed'
            ? item.error
            : `Made ${relativeTime(item.createdAt, now)} while offline. It will be sent automatically when you’re back online — your runner hasn’t been told yet.`}
        </span>
        <div className="row gap-8" style={{ marginTop: 6 }}>
          <button type="button" className="btn btn-soft btn-sm" onClick={() => retryOutboxItem(item.clientRequestId)} disabled={item.state === 'sending'}>
            <Send /> Try now
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => discardOutboxItem(item.clientRequestId)} disabled={item.state === 'sending'}>
            <Trash2 /> Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export function MomHome({ me }: { me: PublicUser }) {
  useTitle('Home');
  const navigate = useNavigate();
  const requests = useApp((s) => s.requests);
  const loaded = useApp((s) => s.dataLoaded);
  const outbox = useApp((s) => s.outbox);
  const active = selectActive(requests).sort((a, b) => b.createdAt - a.createdAt);
  const recent = selectFinished(requests).slice(0, 4);

  return (
    <div className="page">
      <div className="two-col">
        <div className="col-left">
          <div className="sticky-col">
            <header className="greeting">
              <p className="greeting-eyebrow">{greeting()},</p>
              <h1 className="greeting-title">{firstName(me.displayName)} 👋</h1>
              <p className="muted">What can we bring you?</p>
            </header>

            <Link to="/new" className="hero-cta">
              <div className="hero-cta-text">
                <span className="hero-cta-kicker">
                  <Sparkles aria-hidden="true" /> MomExpress
                </span>
                <strong>Need something?</strong>
                <span>Ask for anything — it’ll be brought right to you.</span>
              </div>
              <span className="hero-cta-btn">
                <Plus aria-hidden="true" /> New request
              </span>
            </Link>

            <section className="section" aria-labelledby="quick-title">
              <div className="section-head">
                <h2 className="section-title" id="quick-title">
                  Quick requests
                </h2>
              </div>
              <div className="quick-grid">
                {QUICK_REQUESTS.map((q) => {
                  const Icon = QUICK_ICONS[q.type];
                  return (
                    <button key={q.type} type="button" className={`quick-tile tone-${q.type}`} onClick={() => navigate(`/new?quick=${q.type}`)}>
                      <span className={`bubble tone-${q.type}`} aria-hidden="true">
                        <Icon />
                      </span>
                      <span className="quick-label">{q.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="section">
              <PushPrompt role="mom" />
            </div>
          </div>
        </div>

        <div className="col-right">
          {outbox.length > 0 && (
            <section className="section" aria-labelledby="outbox-title">
              <div className="section-head">
                <h2 className="section-title" id="outbox-title">
                  Waiting to send
                </h2>
              </div>
              <div className="stack gap-12">
                {outbox.map((item) => (
                  <OutboxCard key={item.clientRequestId} item={item} />
                ))}
              </div>
            </section>
          )}

          <section className="section" aria-labelledby="active-title">
            <div className="section-head">
              <h2 className="section-title" id="active-title">
                Your requests {active.length > 0 && <span className="count-chip">{active.length}</span>}
              </h2>
            </div>
            {!loaded ? (
              <div className="stack gap-12">
                <CardSkeleton />
                <CardSkeleton />
              </div>
            ) : active.length === 0 ? (
              <div className="card">
                <EmptyState icon={Sparkles} title="Nothing on the way" compact>
                  When you need something, tap a quick request or <Link to="/new" className="text-link">make your own</Link>.
                </EmptyState>
              </div>
            ) : (
              <div className="stack gap-12">
                {active.map((r) => (
                  <MomRequestCard key={r.id} request={r} />
                ))}
              </div>
            )}
          </section>

          <section className="section" aria-labelledby="recent-title">
            <div className="section-head">
              <h2 className="section-title" id="recent-title">
                Recent
              </h2>
              {recent.length > 0 && (
                <Link to="/history" className="section-link">
                  See all <ChevronRight aria-hidden="true" />
                </Link>
              )}
            </div>
            {!loaded ? (
              <div className="card list">
                <RowSkeleton />
                <RowSkeleton />
              </div>
            ) : recent.length === 0 ? (
              <p className="muted small-note">Finished requests will show up here.</p>
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
