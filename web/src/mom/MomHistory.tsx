import { LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { mx } from '../api/mx';
import { finishedAt, selectFinished, upsertRequests, useApp } from '../store/app';
import { day, itemFor, STATUS, time } from './ar';
import { useMomTitle } from './useMomTitle';

/** Everything she asked for before, newest first, with "again" one tap away. */
export function MomHistory() {
  useMomTitle('طلباتي');
  const navigate = useNavigate();
  const requests = useApp((s) => s.requests);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = async (before?: number) => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await mx.listHistory({ before, limit: 30 });
      upsertRequests(page.requests);
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const items = selectFinished(requests).sort((a, b) => finishedAt(b) - finishedAt(a));
  const groups: { label: string; items: typeof items }[] = [];
  for (const r of items) {
    const label = day(finishedAt(r));
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(r);
    else groups.push({ label, items: [r] });
  }

  return (
    <div className="m-page">
      <h1 className="m-hello">طلباتي</h1>
      {items.length === 0 && !loading && <p className="m-empty">لا توجد طلبات سابقة بعد.</p>}
      {groups.map((g) => (
        <section key={g.label} className="m-section">
          <h2 className="m-day">{g.label}</h2>
          {g.items.map((r) => {
            const item = itemFor(r);
            return (
              <div key={r.id} className="m-card m-past">
                <Link to={`/requests/${r.id}`} className="m-past-main">
                  <span className={`m-icon tone-${item.tone}`} aria-hidden="true">
                    <item.icon />
                  </span>
                  <span className="m-grow">
                    <span className="m-card-title">{r.title}</span>
                    <span className="m-card-status">
                      <span className={`m-chip status-${r.status}`}>{STATUS[r.status]}</span> {time(finishedAt(r))}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  className="m-again"
                  onClick={() => navigate(`/send/again?again=${r.id}`)}
                  aria-label={`اطلبي ${r.title} مرة أخرى`}
                >
                  <RotateCcw aria-hidden="true" />
                  <span>مرة أخرى</span>
                </button>
              </div>
            );
          })}
        </section>
      ))}
      {loading && <LoaderCircle className="spin m-spinner" aria-label="جارٍ التحميل" />}
      {failed && (
        <button type="button" className="m-btn m-btn-plain" onClick={() => void load(cursor ?? undefined)}>
          لم نستطع التحميل · حاولي مرة أخرى
        </button>
      )}
      {!loading && !failed && cursor && (
        <button type="button" className="m-btn m-btn-plain" onClick={() => void load(cursor)}>
          عرض المزيد
        </button>
      )}
    </div>
  );
}
