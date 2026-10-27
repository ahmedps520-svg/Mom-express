import { ArrowRight, Ban, Bike, Check, CircleX, Clock, LoaderCircle, MapPin, PackageCheck, RotateCcw, ThumbsUp, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, isActive } from '../../../shared/lifecycle.js';
import type { DeliveryRequest } from '../../../shared/types.js';
import { mx } from '../api/mx';
import { ApiError } from '../api/client';
import { Confetti } from '../components/Confetti';
import { Sheet } from '../components/Sheet';
import { useServerNow, usePrevious } from '../lib/hooks';
import { applyMutation, loadRequestDetail, refreshRequest } from '../lib/sync';
import { upsertRequests, useApp } from '../store/app';
import { toast } from '../store/toasts';
import { day, etaText, itemFor, runnerName, time } from './ar';
import { useMomTitle } from './useMomTitle';

interface Hero {
  icon: LucideIcon;
  title: string;
  sub?: string;
}

function hero(r: DeliveryRequest): Hero {
  const who = runnerName(r);
  switch (r.status) {
    case 'pending':
      return { icon: Clock, title: 'تم إرسال طلبك', sub: 'بانتظار الرد…' };
    case 'accepted':
      return { icon: ThumbsUp, title: `${who} وافق على طلبك` };
    case 'in_progress':
      return { icon: Bike, title: `${who} في الطريق إليك` };
    case 'delivered':
      return { icon: PackageCheck, title: 'وصل طلبك ✓', sub: r.deliveredAt ? `${day(r.deliveredAt)} · ${time(r.deliveredAt)}` : undefined };
    case 'declined':
      return { icon: CircleX, title: `${who} لا يستطيع إحضاره الآن`, sub: r.declineReason ?? undefined };
    default:
      return {
        icon: Ban,
        title: 'أُلغي الطلب',
        sub: r.cancelledBy && r.cancelledBy.id !== r.requester.id ? [`ألغاه ${r.cancelledBy.displayName}`, r.cancelReason].filter(Boolean).join(' · ') : 'ألغيتِ هذا الطلب',
      };
  }
}

const STEPS: { label: string; at: (r: DeliveryRequest) => number | null }[] = [
  { label: 'أُرسل', at: (r) => r.createdAt },
  { label: 'وافق', at: (r) => r.acceptedAt },
  { label: 'في الطريق', at: (r) => r.startedAt },
  { label: 'وصل', at: (r) => r.deliveredAt },
];

function Steps({ request }: { request: DeliveryRequest }) {
  if (request.status === 'declined' || request.status === 'cancelled') return null;
  return (
    <ol className="m-steps">
      {STEPS.map((step, i) => {
        const at = step.at(request);
        const next = !at && (i === 0 || STEPS[i - 1].at(request));
        return (
          <li key={step.label} className={at ? 'done' : next ? 'next' : ''}>
            <span className="m-step-dot" aria-hidden="true">
              {at && <Check />}
            </span>
            <span className="m-step-label">{step.label}</span>
            {at && <span className="m-step-time">{time(at)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function TrackPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const request = useApp((s) => s.requests[id]);
  const me = useApp((s) => s.me)!;
  const now = useServerNow(1000);
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const previous = usePrevious(request?.status);
  useMomTitle(request?.title ?? 'طلبي');

  useEffect(() => {
    loadRequestDetail(id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
    });
  }, [id]);

  useEffect(() => {
    if (previous && previous !== 'delivered' && request?.status === 'delivered') setCelebrate(Date.now());
  }, [previous, request?.status]);

  if (!request) {
    return (
      <div className="m-page m-center">
        {missing ? (
          <>
            <p className="m-card-title">لم نجد هذا الطلب.</p>
            <Link to="/" className="m-btn">
              الرئيسية
            </Link>
          </>
        ) : (
          <LoaderCircle className="spin m-spinner" aria-label="جارٍ التحميل" />
        )}
      </div>
    );
  }

  const h = hero(request);
  const item = itemFor(request);
  const eta = etaText(request, now);
  const canCancel = can('cancel', request, { id: me.id, role: me.role });

  const cancel = async () => {
    setBusy(true);
    try {
      applyMutation(await mx.cancel(request));
      toast({ kind: 'info', title: 'أُلغي الطلب' });
      setConfirming(false);
    } catch (err) {
      if (err instanceof ApiError && err.request) upsertRequests([err.request]);
      if (err instanceof ApiError && err.isNetwork) {
        toast({ kind: 'error', title: 'لا يوجد إنترنت', body: 'لم نتأكد من الإلغاء. حاولي مرة أخرى بعد قليل.' });
        void refreshRequest(request.id);
      } else {
        toast({ kind: 'warning', title: 'لم يُلغَ الطلب', body: 'تغيّر الطلب للتو. انظري إلى حالته الآن.' });
      }
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-page">
      <Confetti fire={celebrate} />
      <Link to="/" className="m-back">
        <ArrowRight aria-hidden="true" /> رجوع
      </Link>

      <section className={`m-hero status-${request.status}`} aria-live="polite">
        <span className="m-hero-icon" aria-hidden="true">
          <h.icon />
        </span>
        <h1 className="m-hero-title">{h.title}</h1>
        {h.sub && <p className="m-hero-sub">{h.sub}</p>}
        {eta && (
          <p className="m-hero-eta">
            {eta}
            <span className="m-small">الوقت تقريبي</span>
          </p>
        )}
      </section>

      <Steps request={request} />

      <section className="m-card m-what">
        <span className={`m-icon tone-${item.tone}`} aria-hidden="true">
          <item.icon />
        </span>
        <span className="m-grow">
          <span className="m-card-title">{request.title}</span>
          <span className="m-card-status">
            <MapPin aria-hidden="true" /> {request.location}
            {request.priority === 'urgent' && <span className="m-urgent-tag">مستعجل</span>}
          </span>
          {request.notes && <span className="m-card-eta">{request.notes}</span>}
        </span>
      </section>

      {canCancel ? (
        <button type="button" className="m-btn m-btn-plain m-btn-danger" onClick={() => setConfirming(true)}>
          إلغاء الطلب
        </button>
      ) : (
        !isActive(request.status) && (
          <button type="button" className="m-btn m-btn-send" onClick={() => navigate(`/send/again?again=${request.id}`)}>
            <RotateCcw aria-hidden="true" /> اطلبيه مرة أخرى
          </button>
        )
      )}

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        busy={busy}
        title="إلغاء الطلب؟"
        closeLabel="إغلاق"
        actions={
          <>
            <button type="button" className="m-btn m-btn-plain" onClick={() => setConfirming(false)} disabled={busy}>
              لا
            </button>
            <button type="button" className="m-btn m-btn-danger" onClick={() => void cancel()} disabled={busy}>
              {busy ? 'جارٍ الإلغاء…' : 'نعم، ألغيه'}
            </button>
          </>
        }
      />
    </div>
  );
}
