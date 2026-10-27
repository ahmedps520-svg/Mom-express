import { BellRing, ChevronLeft, CloudOff, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { DeliveryRequest } from '../../../shared/types.js';
import { useServerNow } from '../lib/hooks';
import { keys, readJson, writeJson } from '../lib/storage';
import { discardOutboxItem, retryOutboxItem } from '../lib/sync';
import { usePush } from '../lib/usePush';
import { selectActive, useApp } from '../store/app';
import { etaText, greeting, ITEMS, itemFor, runnerName } from './ar';
import { useMomTitle } from './useMomTitle';

/** What's happening with a request, in a few words. */
export function statusLine(r: DeliveryRequest): string {
  switch (r.status) {
    case 'pending':
      return 'أُرسل · بانتظار الرد';
    case 'accepted':
      return `${runnerName(r)} وافق على طلبك`;
    case 'in_progress':
      return `${runnerName(r)} في الطريق إليك`;
    case 'delivered':
      return 'وصل ✓';
    case 'declined':
      return `${runnerName(r)} لا يستطيع إحضاره الآن`;
    default:
      return 'أُلغي الطلب';
  }
}

function ActiveCard({ request, now }: { request: DeliveryRequest; now: number }) {
  const item = itemFor(request);
  const eta = etaText(request, now);
  return (
    <Link to={`/requests/${request.id}`} className={`m-card m-active status-${request.status}`}>
      <span className={`m-icon tone-${item.tone}`} aria-hidden="true">
        <item.icon />
      </span>
      <span className="m-grow">
        <span className="m-card-title">{request.title}</span>
        <span className="m-card-status">{statusLine(request)}</span>
        {eta && <span className="m-card-eta">{eta}</span>}
      </span>
      <ChevronLeft className="m-chev" aria-hidden="true" />
    </Link>
  );
}

function Outbox() {
  const outbox = useApp((s) => s.outbox);
  if (outbox.length === 0) return null;
  return (
    <section className="m-section">
      {outbox.map((item) => (
        <div key={item.clientRequestId} className="m-card m-outbox" role="status">
          <span className="m-icon tone-default" aria-hidden="true">
            <CloudOff />
          </span>
          <span className="m-grow">
            <span className="m-card-title">{item.payload.title}</span>
            <span className="m-card-status">
              {item.state === 'failed' ? 'لم يُرسل. حاولي مرة أخرى.' : 'لم يُرسل بعد · سيُرسل عندما يعود الإنترنت'}
            </span>
            {item.state === 'failed' && (
              <span className="m-row">
                <button type="button" className="m-btn m-btn-small" onClick={() => retryOutboxItem(item.clientRequestId)}>
                  حاولي مرة أخرى
                </button>
                <button type="button" className="m-btn m-btn-small m-btn-plain" onClick={() => discardOutboxItem(item.clientRequestId)}>
                  احذفيه
                </button>
              </span>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}

/** Asks once to turn on notifications, so she hears when things arrive. */
function PushCard() {
  const push = usePush('ar');
  const [hidden, setHidden] = useState(() => readJson<boolean>(keys.dismissedPushCard) === true);
  if (hidden || push.state.kind !== 'off') return null;
  return (
    <section className="m-card m-push">
      <span className="m-icon tone-help" aria-hidden="true">
        <BellRing />
      </span>
      <span className="m-grow">
        <span className="m-card-title">شغّلي الإشعارات</span>
        <span className="m-card-status">لتعرفي متى وافق ومتى وصل طلبك، حتى والتطبيق مغلق.</span>
        <span className="m-row">
          <button type="button" className="m-btn m-btn-small" disabled={push.busy} onClick={() => void push.enable()}>
            تشغيل
          </button>
        </span>
      </span>
      <button
        type="button"
        className="m-close"
        aria-label="إخفاء"
        onClick={() => {
          writeJson(keys.dismissedPushCard, true);
          setHidden(true);
        }}
      >
        <X />
      </button>
    </section>
  );
}

export function MomHome() {
  useMomTitle('الرئيسية');
  const requests = useApp((s) => s.requests);
  const loaded = useApp((s) => s.dataLoaded);
  const now = useServerNow(5000);
  const active = selectActive(requests).sort((a, b) => b.id - a.id);

  return (
    <div className="m-page">
      <h1 className="m-hello">{greeting()}</h1>
      <Outbox />
      {active.length > 0 && (
        <section className="m-section" aria-label="طلباتك الآن">
          {active.map((r) => (
            <ActiveCard key={r.id} request={r} now={now} />
          ))}
        </section>
      )}
      <h2 className="m-ask">ماذا تحتاجين؟</h2>
      <div className="m-grid">
        {ITEMS.map((item) => (
          <Link key={item.key} to={`/send/${item.key}`} className={`m-tile tone-${item.tone}`}>
            <item.icon aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
      {loaded && <PushCard />}
    </div>
  );
}
