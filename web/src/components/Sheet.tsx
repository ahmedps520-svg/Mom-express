import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal sheet (slides up on phones, centred dialog on larger screens).
 * Uses the native <dialog> element for focus handling and Escape to close.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  busy = false,
  closeLabel = 'Close',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** While true, the sheet can't be dismissed (an action is saving). */
  busy?: boolean;
  closeLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (!busyRef.current) onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="sheet-title"
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current && !busyRef.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="sheet-grip" aria-hidden="true" />
          <div className="sheet-head">
            <div className="grow">
              <h2 className="sheet-title" id="sheet-title">
                {title}
              </h2>
              {description && <p className="sheet-desc">{description}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label={closeLabel}>
              <X />
            </button>
          </div>
          {children && <div className="sheet-body">{children}</div>}
          {actions && <div className="sheet-actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}
