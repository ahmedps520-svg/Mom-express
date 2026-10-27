import { ArrowLeft, CircleAlert, Cookie, GlassWater, HandHelping, LoaderCircle, MapPin, PenLine, Pill, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { LIMITS, LOCATIONS, QUICK_REQUESTS } from '../../../shared/constants.js';
import { isActive, isFinal, STATUS_LABELS } from '../../../shared/lifecycle.js';
import type { DeliveryRequest, Priority, PublicUser, QuickType } from '../../../shared/types.js';
import { createRequestSchema, fieldErrors as zodFieldErrors, updateRequestSchema } from '../../../shared/validation.js';
import { ApiError } from '../api/client';
import { mx } from '../api/mx';
import { ConfirmSheet } from '../components/ActionSheets';
import { EmptyState } from '../components/EmptyState';
import { runRequestAction } from '../lib/actions';
import { useBack, useTitle } from '../lib/hooks';
import { newClientRequestId } from '../lib/id';
import { createRequest, loadRequestDetail, queueRequest } from '../lib/sync';
import { useApp } from '../store/app';
import { toast } from '../store/toasts';

const QUICK_ICONS = { water: GlassWater, snack: Cookie, help: HandHelping, medicine: Pill };

const PRIORITY_OPTIONS: { value: Priority; label: string; hint: string }[] = [
  { value: 'normal', label: 'Normal', hint: 'When you can' },
  { value: 'high', label: 'High', hint: 'Soon, please' },
  { value: 'urgent', label: 'Urgent', hint: 'Right away' },
];

interface FormValues {
  title: string;
  description: string;
  location: string;
  priority: Priority;
  notes: string;
}

const blank: FormValues = { title: '', description: '', location: '', priority: 'normal', notes: '' };

function Counter({ value, max }: { value: string; max: number }) {
  if (value.length < max * 0.7) return null;
  return <span className={`counter${value.length > max * 0.9 ? ' near' : ''}`}>{value.length}/{max}</span>;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span className="field-error" id={id} role="alert">
      <CircleAlert aria-hidden="true" /> {message}
    </span>
  );
}

export function RequestFormPage({ me, mode }: { me: PublicUser; mode: 'new' | 'edit' }) {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const back = useBack(mode === 'edit' && params.id ? `/requests/${params.id}` : '/');
  const editId = mode === 'edit' ? Number(params.id) : null;
  const againId = mode === 'new' && search.get('again') ? Number(search.get('again')) : null;
  const sourceId = editId ?? againId;
  const source = useApp((s) => (sourceId ? s.requests[sourceId] : undefined));
  const requests = useApp((s) => s.requests);
  useTitle(mode === 'edit' ? 'Edit request' : 'New request');

  const [values, setValues] = useState<FormValues>(blank);
  const [quickType, setQuickType] = useState<QuickType | null>(null);
  const [customLocation, setCustomLocation] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialised, setInitialised] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DeliveryRequest | null>(null);
  // One id per form: resubmitting the same form can never create two requests.
  const clientRequestId = useMemo(() => newClientRequestId(), []);
  const formRef = useRef<HTMLFormElement>(null);

  // Load the request being edited or repeated, if it isn't already in memory.
  useEffect(() => {
    if (!sourceId || source) return;
    loadRequestDetail(sourceId).catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Couldn’t load that request.'));
  }, [sourceId, source]);

  // Fill the form once: from the request being edited/repeated, a quick request, or blank.
  useEffect(() => {
    if (initialised) return;
    if (sourceId) {
      if (!source) return;
      setValues({
        title: source.title,
        description: source.description,
        location: source.location,
        priority: source.priority,
        notes: source.notes,
      });
      setQuickType(source.quickType);
      setCustomLocation(!(LOCATIONS as readonly string[]).includes(source.location));
    } else {
      const template = QUICK_REQUESTS.find((q) => q.type === search.get('quick'));
      const location = me.prefs.lastLocation ?? '';
      setValues({ ...(template ?? blank), location });
      setQuickType(template?.type ?? null);
      setCustomLocation(location !== '' && !(LOCATIONS as readonly string[]).includes(location));
    }
    setInitialised(true);
  }, [initialised, sourceId, source, search, me.prefs.lastLocation]);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: '' }));
  };

  const applyQuick = (type: QuickType) => {
    const t = QUICK_REQUESTS.find((q) => q.type === type)!;
    setValues((v) => ({ ...v, title: t.title, description: t.description, priority: t.priority, notes: t.notes }));
    setQuickType(type);
    setErrors({});
  };

  const focusFirstError = (errs: Record<string, string>) => {
    const first = ['title', 'location', 'priority', 'description', 'notes'].find((k) => errs[k]);
    if (!first) return;
    const el = formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`);
    el?.focus();
  };

  const payload = () => {
    const template = QUICK_REQUESTS.find((q) => q.type === quickType);
    return {
      clientRequestId,
      ...values,
      // Keep the quick-request icon only while it still describes the request.
      quickType: template && template.title === values.title.trim() ? template.type : null,
    };
  };

  const send = async () => {
    const parsed = createRequestSchema.safeParse(payload());
    if (!parsed.success) return;
    setBusy(true);
    setFormError(null);
    try {
      const request = await createRequest(parsed.data);
      toast({ kind: 'success', title: 'Request sent!', body: `Your runner has been told about “${request.title}”.` });
      navigate(`/requests/${request.id}`, { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.isNetwork) {
        // Not lost and not pretended: it's kept here and sent when we're back
        // online. Resending is safe; the server won't create it twice.
        queueRequest(parsed.data);
        toast({
          kind: 'warning',
          title: 'May not have been sent',
          body: 'We couldn’t reach MomExpress. It’s saved here and will be sent automatically when you’re back online.',
        });
        navigate('/', { replace: true });
      } else if (err instanceof ApiError && err.status === 401) {
        // Signed out mid-send: it goes out once you sign back in.
        queueRequest(parsed.data);
        toast({ kind: 'warning', title: 'Not sent yet', body: 'Sign in again and it will be sent automatically.' });
      } else if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        focusFirstError(err.fields);
      } else {
        setFormError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      }
    }
  };

  const save = async () => {
    if (!source) return;
    const changes: Partial<FormValues> = {};
    for (const key of Object.keys(values) as (keyof FormValues)[]) {
      const next = typeof values[key] === 'string' ? values[key].trim() : values[key];
      if (next !== source[key]) (changes as Record<string, string>)[key] = values[key];
    }
    if (Object.keys(changes).length === 0) {
      back();
      return;
    }
    const parsed = updateRequestSchema.safeParse(changes);
    if (!parsed.success) {
      const errs = zodFieldErrors(parsed.error);
      setErrors(errs);
      focusFirstError(errs);
      return;
    }
    setBusy(true);
    const updated = await runRequestAction(source, () => mx.editRequest(source, parsed.data), {
      title: 'Changes saved',
      body: 'Your runner can see the update.',
    });
    setBusy(false);
    if (updated) back();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'edit') {
      void save();
      return;
    }
    const parsed = createRequestSchema.safeParse(payload());
    if (!parsed.success) {
      const errs = zodFieldErrors(parsed.error);
      setErrors(errs);
      focusFirstError(errs);
      return;
    }
    // A gentle check against asking for the same thing twice by accident.
    const same = Object.values(requests).find((r) => isActive(r.status) && r.title.toLowerCase() === parsed.data.title.toLowerCase());
    if (same) {
      setDuplicate(same);
      return;
    }
    void send();
  };

  if (loadError) {
    return (
      <div className="page narrow">
        <div className="card">
          <EmptyState icon={CircleAlert} title="Couldn’t open this request" action={<Link className="btn btn-secondary" to="/">Back home</Link>}>
            {loadError}
          </EmptyState>
        </div>
      </div>
    );
  }

  if (mode === 'edit' && source && isFinal(source.status)) {
    return (
      <div className="page narrow">
        <div className="card">
          <EmptyState
            icon={PenLine}
            title="This request can’t be edited"
            action={
              <Link className="btn btn-secondary" to={`/requests/${source.id}`}>
                View request
              </Link>
            }
          >
            It’s already {STATUS_LABELS[source.status].toLowerCase()}, so its details are final.
          </EmptyState>
        </div>
      </div>
    );
  }

  const ready = initialised;

  return (
    <div className="page narrow">
      <div className="detail-top">
        <button type="button" className="icon-btn" onClick={back} aria-label="Back">
          <ArrowLeft />
        </button>
        <div className="grow">
          <h1 className="page-title">{mode === 'edit' ? 'Edit request' : againId ? 'Request again' : 'New request'}</h1>
          <p className="page-sub">{mode === 'edit' ? 'Your runner will see the changes straight away.' : 'Just say what you need — that’s all it takes.'}</p>
        </div>
      </div>

      {mode === 'new' && (
        <div className="chip-scroll quick-chips" role="group" aria-label="Quick requests">
          {QUICK_REQUESTS.map((q) => {
            const Icon = QUICK_ICONS[q.type];
            return (
              <button key={q.type} type="button" className="chip" aria-pressed={quickType === q.type} onClick={() => applyQuick(q.type)}>
                <Icon aria-hidden="true" /> {q.label}
              </button>
            );
          })}
        </div>
      )}

      <form ref={formRef} className="card card-pad request-form" onSubmit={submit} noValidate aria-busy={!ready}>
        {formError && (
          <div className="banner banner-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{formError}</span>
          </div>
        )}

        <div className={`field${errors.title ? ' invalid' : ''}`}>
          <label className="label" htmlFor="title">
            What do you need? <Counter value={values.title} max={LIMITS.title} />
          </label>
          <input
            id="title"
            name="title"
            className="input big"
            placeholder="e.g. My phone charger"
            value={values.title}
            maxLength={LIMITS.title}
            onChange={(e) => set('title', e.target.value)}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? 'title-error' : undefined}
            autoComplete="off"
            enterKeyHint="send"
          />
          <FieldError id="title-error" message={errors.title} />
        </div>

        <div className={`field${errors.description ? ' invalid' : ''}`}>
          <label className="label" htmlFor="description">
            <span>
              Details <span className="optional">Optional</span>
            </span>
            <Counter value={values.description} max={LIMITS.description} />
          </label>
          <textarea
            id="description"
            name="description"
            className="textarea"
            rows={2}
            placeholder="Which one, how much, anything that helps"
            value={values.description}
            maxLength={LIMITS.description}
            onChange={(e) => set('description', e.target.value)}
          />
          <FieldError id="description-error" message={errors.description} />
        </div>

        <fieldset className={`field${errors.location ? ' invalid' : ''}`}>
          <legend className="label">Deliver to</legend>
          <div className="chip-row" role="group" aria-label="Delivery location">
            {LOCATIONS.map((loc) => (
              <button
                key={loc}
                type="button"
                name={loc === LOCATIONS[0] && !customLocation ? 'location' : undefined}
                className="chip"
                aria-pressed={!customLocation && values.location === loc}
                onClick={() => {
                  setCustomLocation(false);
                  set('location', loc);
                }}
              >
                <MapPin aria-hidden="true" /> {loc}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              aria-pressed={customLocation}
              onClick={() => {
                if (!customLocation) {
                  setCustomLocation(true);
                  set('location', '');
                }
              }}
            >
              <PenLine aria-hidden="true" /> Somewhere else
            </button>
          </div>
          {customLocation && (
            <input
              name="location"
              className="input"
              placeholder="e.g. Garden, Study, Front porch"
              value={values.location}
              maxLength={LIMITS.location}
              onChange={(e) => set('location', e.target.value)}
              aria-label="Where should it go?"
              aria-invalid={!!errors.location}
              autoFocus
            />
          )}
          <FieldError id="location-error" message={errors.location} />
        </fieldset>

        <fieldset className="field">
          <legend className="label">How soon?</legend>
          <div className="segmented" role="group" aria-label="Priority">
            {PRIORITY_OPTIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`seg-${p.value}`}
                aria-pressed={values.priority === p.value}
                onClick={() => set('priority', p.value)}
              >
                {p.label}
                <small>{p.hint}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <div className={`field${errors.notes ? ' invalid' : ''}`}>
          <label className="label" htmlFor="notes">
            <span>
              Notes for your runner <span className="optional">Optional</span>
            </span>
            <Counter value={values.notes} max={LIMITS.notes} />
          </label>
          <textarea
            id="notes"
            name="notes"
            className="textarea"
            rows={2}
            placeholder="e.g. It’s on the kitchen counter"
            value={values.notes}
            maxLength={LIMITS.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
          <FieldError id="notes-error" message={errors.notes} />
        </div>

        <div className="form-submit">
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !ready}>
            {busy ? (
              <>
                <LoaderCircle className="spin" aria-hidden="true" /> {mode === 'edit' ? 'Saving…' : 'Sending…'}
              </>
            ) : mode === 'edit' ? (
              'Save changes'
            ) : (
              <>
                <Send aria-hidden="true" /> Send request
              </>
            )}
          </button>
        </div>
      </form>

      <ConfirmSheet
        open={duplicate !== null}
        onClose={() => setDuplicate(null)}
        busy={busy}
        title="You’ve already asked for this"
        description={duplicate ? `“${duplicate.title}” is still ${STATUS_LABELS[duplicate.status].toLowerCase()}. Send another one anyway?` : undefined}
        cancelLabel="See the first one"
        onCancel={() => duplicate && navigate(`/requests/${duplicate.id}`)}
        confirmLabel="Send another"
        onConfirm={() => {
          setDuplicate(null);
          void send();
        }}
      />
    </div>
  );
}
