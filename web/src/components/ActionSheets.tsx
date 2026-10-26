import { Check, Minus, Plus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ETA_PRESETS, LIMITS } from '../../../shared/constants.js';
import { Sheet } from './Sheet';

/** Pick an ETA: one tap on a preset submits straight away. */
export function EtaSheet({
  open,
  onClose,
  onSubmit,
  title,
  description,
  busy,
  skipLabel,
  onSkip,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (minutes: number) => void;
  title: string;
  description?: string;
  busy: boolean;
  /** Optional secondary action, e.g. "Accept without an ETA". */
  skipLabel?: string;
  onSkip?: () => void;
}) {
  const [custom, setCustom] = useState(8);
  const [chosen, setChosen] = useState<number | null>(null);

  useEffect(() => {
    if (open) setChosen(null);
  }, [open]);

  const submit = (minutes: number) => {
    setChosen(minutes);
    onSubmit(minutes);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      busy={busy}
      actions={
        onSkip ? (
          <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={busy}>
            {skipLabel}
          </button>
        ) : undefined
      }
    >
      <div className="eta-grid">
        {ETA_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            className={`eta-choice${chosen === m && busy ? ' loading' : ''}`}
            onClick={() => submit(m)}
            disabled={busy}
          >
            <strong>{m}</strong>
            <span>min</span>
          </button>
        ))}
      </div>
      <div className="eta-custom">
        <span className="label">Something else</span>
        <div className="row gap-8">
          <button
            type="button"
            className="icon-btn stepper"
            onClick={() => setCustom((c) => Math.max(LIMITS.etaMinMinutes, c - 1))}
            disabled={busy || custom <= LIMITS.etaMinMinutes}
            aria-label="One minute less"
          >
            <Minus />
          </button>
          <output className="eta-custom-value" aria-live="polite">
            {custom} min
          </output>
          <button
            type="button"
            className="icon-btn stepper"
            onClick={() => setCustom((c) => Math.min(LIMITS.etaMaxMinutes, c + 1))}
            disabled={busy || custom >= LIMITS.etaMaxMinutes}
            aria-label="One minute more"
          >
            <Plus />
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => submit(custom)} disabled={busy}>
            <Check /> Set
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** Confirm a decline or cancellation, with an optional reason for the other person. */
export function ReasonSheet({
  open,
  onClose,
  onSubmit,
  title,
  description,
  confirmLabel,
  suggestions,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  suggestions: string[];
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      busy={busy}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Go back
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={() => onSubmit(reason.trim())} disabled={busy}>
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="reason-input">
          Reason <span className="optional">Optional</span>
        </label>
        <div className="chip-row">
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip chip-sm" aria-pressed={reason === s} onClick={() => setReason(reason === s ? '' : s)}>
              {s}
            </button>
          ))}
        </div>
        <textarea
          id="reason-input"
          className="textarea"
          rows={2}
          maxLength={LIMITS.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Add a short note…"
        />
      </div>
    </Sheet>
  );
}

/** A simple yes/no confirmation. */
export function ConfirmSheet({
  open,
  onClose,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Go back',
  danger = false,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  /** What the cancel button does, if more than closing the sheet. */
  onCancel?: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy: boolean;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      busy={busy}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel ?? onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </>
      }
    />
  );
}
