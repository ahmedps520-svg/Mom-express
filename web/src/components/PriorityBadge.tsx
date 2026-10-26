import { Flame } from 'lucide-react';
import { PRIORITY_LABELS } from '../../../shared/constants.js';
import type { Priority } from '../../../shared/types.js';

export function PriorityBadge({ priority, showNormal = false }: { priority: Priority; showNormal?: boolean }) {
  if (priority === 'normal' && !showNormal) return null;
  return (
    <span className={`prio prio-${priority}`}>
      {priority === 'urgent' ? <span className="pulse-dot" aria-hidden="true" /> : priority === 'high' ? <Flame aria-hidden="true" /> : null}
      {PRIORITY_LABELS[priority]}
    </span>
  );
}
