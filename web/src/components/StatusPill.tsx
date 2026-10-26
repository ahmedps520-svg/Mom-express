import { STATUS_LABELS } from '../../../shared/lifecycle.js';
import type { RequestStatus } from '../../../shared/types.js';

export function StatusPill({ status }: { status: RequestStatus }) {
  return (
    <span key={status} className={`status-pill status-${status}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}
