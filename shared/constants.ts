import type { NotificationType, Priority, QuickType, Role, UserPrefs } from './types.js';

export const LIMITS = {
  title: 80,
  description: 500,
  notes: 500,
  location: 40,
  reason: 200,
  displayName: 40,
  etaMinMinutes: 1,
  etaMaxMinutes: 180,
  passwordMin: 8,
  passwordMax: 200,
} as const;

/** Common household destinations. Mom can always type her own instead. */
export const LOCATIONS = ['Bedroom', 'Living room', 'Kitchen', 'Upstairs', 'Downstairs'] as const;

export const PRIORITIES: Priority[] = ['normal', 'high', 'urgent'];

export const PRIORITY_LABELS: Record<Priority, string> = {
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export interface QuickRequestTemplate {
  type: QuickType;
  label: string;
  title: string;
  description: string;
  priority: Priority;
  notes: string;
}

/**
 * Shortcuts shown on Mom's home screen. They only pre-fill the request form;
 * everything stays editable before it is sent.
 */
export const QUICK_REQUESTS: QuickRequestTemplate[] = [
  {
    type: 'water',
    label: 'Water',
    title: 'Glass of water',
    description: 'A glass of cold water, please.',
    priority: 'normal',
    notes: '',
  },
  {
    type: 'snack',
    label: 'Snack',
    title: 'A snack',
    description: 'Something light to munch on.',
    priority: 'normal',
    notes: 'Surprise me!',
  },
  {
    type: 'help',
    label: 'Help',
    title: 'Help needed',
    description: 'Could you come and give me a hand?',
    priority: 'high',
    notes: '',
  },
  {
    type: 'medicine',
    label: 'Medicine',
    title: 'My medicine',
    description: 'Please bring my medicine.',
    priority: 'high',
    notes: 'With a glass of water, please.',
  },
];

export const ETA_PRESETS = [2, 5, 10, 15, 20, 30];

/** An ETA change smaller than this is not worth a separate notification. */
export const SIGNIFICANT_ETA_CHANGE_MS = 2 * 60_000;

export interface NotificationCategory {
  type: NotificationType;
  label: string;
  description: string;
  defaultPush: boolean;
}

export const NOTIFICATION_CATEGORIES: Record<Role, NotificationCategory[]> = {
  mom: [
    { type: 'accepted', label: 'Request accepted', description: 'When your runner takes a request.', defaultPush: true },
    { type: 'started', label: 'On the way', description: 'When your delivery sets off.', defaultPush: true },
    { type: 'eta_updated', label: 'ETA changes', description: 'When the estimated arrival changes noticeably.', defaultPush: true },
    { type: 'delivered', label: 'Delivered', description: 'When your request arrives.', defaultPush: true },
    { type: 'declined', label: 'Declined', description: 'When a request can’t be taken.', defaultPush: true },
    { type: 'cancelled', label: 'Cancelled', description: 'When your runner can’t finish a delivery.', defaultPush: true },
    { type: 'submitted', label: 'Sent confirmations', description: 'A confirmation each time you send a request.', defaultPush: false },
  ],
  runner: [
    { type: 'new_request', label: 'New requests', description: 'Every time a new request comes in.', defaultPush: true },
    { type: 'cancelled', label: 'Cancellations', description: 'When a request you’re handling is cancelled.', defaultPush: true },
    { type: 'details_updated', label: 'Request changes', description: 'When the details of a request change.', defaultPush: true },
  ],
};

export function defaultPrefs(role: Role): UserPrefs {
  const push: UserPrefs['push'] = {};
  for (const c of NOTIFICATION_CATEGORIES[role]) push[c.type] = c.defaultPush;
  return { push, sound: true, theme: 'system' };
}
