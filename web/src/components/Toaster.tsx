import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store/app';
import { dismissToast, useToasts, type ToastKind } from '../store/toasts';

const ICONS: Record<ToastKind, typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
  warning: TriangleAlert,
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const arabic = useApp((s) => s.me?.role === 'mom');
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon" aria-hidden="true">
              <Icon />
            </span>
            <div className="grow">
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
            {t.action && (
              <button
                type="button"
                className="btn btn-soft btn-sm"
                onClick={() => {
                  t.action!.run();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => dismissToast(t.id)} aria-label={arabic ? 'إغلاق' : 'Dismiss'}>
              <X />
            </button>
          </div>
        );
      })}
    </div>
  );
}
