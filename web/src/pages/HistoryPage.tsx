import { History, LoaderCircle, SearchX } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { PublicUser, RequestListResponse, RequestStatus } from '../../../shared/types.js';
import { api, ApiError } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { HistoryRow } from '../components/RequestCards';
import { RowSkeleton } from '../components/Skeletons';
import { dayLabel, startOfDay } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { finishedAt, selectFinished, upsertRequests, useApp } from '../store/app';

const FILTERS: { value: 'all' | RequestStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'declined', label: 'Declined' },
];

export function HistoryPage({ me }: { me: PublicUser }) {
  useTitle('History');
  const [search, setSearch] = useSearchParams();
  const filter = (FILTERS.find((f) => f.value === search.get('status'))?.value ?? 'all') as 'all' | RequestStatus;
  const requests = useApp((s) => s.requests);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      const qs = new URLSearchParams({ scope: 'history', limit: '30' });
      if (filter !== 'all') qs.set('status', filter);
      if (before) qs.set('before', String(before));
      const page = await api.get<RequestListResponse>(`/api/requests?${qs}`);
      upsertRequests(page.requests);
      setCursor(page.nextCursor);
    },
    [filter],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : 'Couldn’t load history.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load more.');
    } finally {
      setLoadingMore(false);
    }
  };

  const items = selectFinished(requests)
    .filter((r) => filter === 'all' || r.status === filter)
    .sort((a, b) => finishedAt(b) - finishedAt(a));

  // Group by the day each request finished.
  const groups: { day: number; items: typeof items }[] = [];
  for (const r of items) {
    const day = startOfDay(finishedAt(r));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(r);
    else groups.push({ day, items: [r] });
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">History</h1>
          <p className="page-sub">{me.role === 'mom' ? 'Everything you’ve asked for.' : 'Every delivery, start to finish.'}</p>
        </div>
      </div>

      <div className="chip-scroll" role="group" aria-label="Filter by outcome">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="chip"
            aria-pressed={filter === f.value}
            onClick={() => setSearch(f.value === 'all' ? {} : { status: f.value }, { replace: true })}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && items.length === 0 ? (
        <div className="card section">
          <EmptyState icon={SearchX} title="Couldn’t load history" compact>
            {error}
          </EmptyState>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="card list section">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : items.length === 0 ? (
        <div className="card section">
          <EmptyState icon={History} title={filter === 'all' ? 'No history yet' : `Nothing ${filter} yet`} compact>
            {filter === 'all' ? 'Finished requests stay here, so you can always look back.' : 'Try another filter.'}
          </EmptyState>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.day} className="section history-group" aria-label={dayLabel(g.day, Date.now(), true)}>
              <h2 className="group-label">{dayLabel(g.day, Date.now(), true)}</h2>
              <div className="card list">
                {g.items.map((r) => (
                  <HistoryRow key={r.id} request={r} me={me} />
                ))}
              </div>
            </section>
          ))}
          {cursor && (
            <div className="load-more">
              <button type="button" className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? (
                  <>
                    <LoaderCircle className="spin" aria-hidden="true" /> Loading…
                  </>
                ) : (
                  'Show older'
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
