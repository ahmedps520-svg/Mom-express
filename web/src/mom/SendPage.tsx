import { ArrowRight, LoaderCircle, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { isActive } from '../../../shared/lifecycle.js';
import type { Priority, PublicUser } from '../../../shared/types.js';
import { ApiError } from '../api/client';
import { newClientRequestId } from '../lib/id';
import { createRequest, loadRequestDetail, queueRequest } from '../lib/sync';
import { useApp } from '../store/app';
import { toast } from '../store/toasts';
import { ITEMS, itemFor } from './ar';
import { PlacePicker } from './PlacePicker';
import { useMomTitle } from './useMomTitle';

/**
 * Sending a request: what (already chosen on the home screen, or typed for
 * "something else"), where, and send. Urgent and a note are optional extras.
 */
export function SendPage({ me }: { me: PublicUser }) {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const againId = Number(search.get('again')) || null;
  const again = useApp((s) => (againId ? s.requests[againId] : undefined));
  const requests = useApp((s) => s.requests);
  const item = ITEMS.find((i) => i.key === params.item);
  const shown = again ? itemFor(again) : item;
  const custom = item?.key === 'other' && !again;

  const [title, setTitle] = useState(again?.title ?? item?.title ?? '');
  const [place, setPlace] = useState(again?.location ?? me.prefs.lastLocation ?? '');
  const [urgent, setUrgent] = useState(again?.priority === 'urgent');
  const [note, setNote] = useState(again?.notes ?? '');
  const [showNote, setShowNote] = useState(Boolean(again?.notes));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per visit to this screen: pressing send twice never makes two requests.
  const clientRequestId = useMemo(() => newClientRequestId(), []);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useMomTitle(shown?.label ?? 'طلب جديد');

  // "Request again" from a request that isn't loaded yet.
  useEffect(() => {
    if (againId && !again) void loadRequestDetail(againId).catch(() => {});
  }, [againId, again]);
  useEffect(() => {
    if (!again) return;
    setTitle(again.title);
    setPlace(again.location);
    setNote(again.notes);
    setShowNote(Boolean(again.notes));
    setUrgent(again.priority === 'urgent');
  }, [again]);

  if (!shown) {
    return againId ? (
      <div className="m-page m-center">
        <LoaderCircle className="spin m-spinner" aria-label="جارٍ التحميل" />
      </div>
    ) : (
      <Navigate to="/" replace />
    );
  }

  const where = place.trim();
  const what = title.trim();
  const sameActive = Object.values(requests).find((r) => isActive(r.status) && r.title === what);

  const send = async () => {
    if (busy) return;
    if (!what) {
      setProblem('اكتبي ما تحتاجينه.');
      titleRef.current?.focus();
      return;
    }
    if (!where) {
      setProblem('اختاري أين أنتِ.');
      return;
    }
    if (what.length > 80 || where.length > 40 || note.length > 500) {
      setProblem('الكلام طويل جداً. اختصريه قليلاً.');
      return;
    }
    const base = again?.priority ?? item?.priority ?? 'normal';
    const priority: Priority = urgent ? 'urgent' : base === 'urgent' ? 'high' : base;
    const payload = {
      clientRequestId,
      title: what,
      description: '',
      location: where,
      priority,
      notes: showNote ? note.trim() : '',
      quickType: shown.quickType && shown.title === what ? shown.quickType : null,
    };
    setBusy(true);
    setProblem(null);
    try {
      const request = await createRequest(payload);
      toast({ kind: 'success', title: 'تم إرسال طلبك ✓' });
      navigate(`/requests/${request.id}`, { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && (err.isNetwork || err.status === 401)) {
        // Kept on the phone and sent by itself once the connection is back.
        queueRequest(payload);
        toast({ kind: 'warning', title: 'لم يُرسل بعد', body: 'سنرسله تلقائياً عندما يعود الإنترنت.' });
        navigate('/', { replace: true });
      } else {
        setProblem('لم نستطع إرسال الطلب. حاولي مرة أخرى.');
      }
    }
  };

  return (
    <div className="m-page">
      <Link to="/" className="m-back">
        <ArrowRight aria-hidden="true" /> رجوع
      </Link>

      <div className="m-send-head">
        <span className={`m-icon m-icon-big tone-${shown.tone}`} aria-hidden="true">
          <shown.icon />
        </span>
        {custom ? (
          <label className="m-field m-grow">
            <span className="m-label">ماذا تحتاجين؟</span>
            <textarea
              ref={titleRef}
              className="m-input"
              rows={2}
              maxLength={80}
              value={title}
              autoFocus
              placeholder="اكتبي هنا…"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        ) : (
          <h1 className="m-send-title">{what || shown.label}</h1>
        )}
      </div>

      <PlacePicker
        key={again?.id ?? 'new'}
        value={place}
        focusOther={!custom}
        onChange={(p) => {
          setPlace(p);
          setProblem(null);
        }}
      />

      <div className="m-extras">
        <button type="button" className="m-toggle m-urgent" aria-pressed={urgent} onClick={() => setUrgent((u) => !u)}>
          <TriangleAlert aria-hidden="true" /> مستعجل
        </button>
        <button type="button" className="m-toggle" aria-pressed={showNote} onClick={() => setShowNote((s) => !s)}>
          ملاحظة
        </button>
      </div>
      {showNote && (
        <textarea
          className="m-input"
          rows={2}
          maxLength={500}
          aria-label="ملاحظة"
          placeholder="مثلاً: ماء بارد"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}

      {sameActive && <p className="m-note">طلبتِ هذا قبل قليل وهو في الطريق. يمكنك إرساله مرة أخرى إذا أردتِ.</p>}
      {problem && (
        <p className="m-problem" role="alert">
          {problem}
        </p>
      )}

      <button type="button" className="m-btn m-btn-send" onClick={() => void send()} disabled={busy}>
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
        {busy ? 'جارٍ الإرسال…' : 'أرسل'}
      </button>
    </div>
  );
}
