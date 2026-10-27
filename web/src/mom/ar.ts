import { Coffee, Cookie, GlassWater, HandHelping, PenLine, Pill, type LucideIcon } from 'lucide-react';
import type { DeliveryRequest, Priority, QuickType, RequestStatus } from '../../../shared/types.js';
import { startOfDay } from '../lib/format';

// Words and formatting for Mom's app, which is in Arabic only.

// Arabic digits (٠١٢٣…) everywhere, whatever the browser's default for Arabic.
const LOCALE = 'ar-u-nu-arab';
const numberFmt = new Intl.NumberFormat(LOCALE);
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

/** A number in Arabic digits, e.g. ٥. */
export const num = (n: number) => numberFmt.format(n);

/** "دقيقة", "دقيقتين", "٥ دقائق", "١٥ دقيقة" — Arabic changes the word with the number. */
export function minutes(n: number): string {
  if (n <= 1) return 'دقيقة';
  if (n === 2) return 'دقيقتين';
  if (n <= 10) return `${num(n)} دقائق`;
  return `${num(n)} دقيقة`;
}

export const time = (ts: number) => timeFmt.format(ts);

export function day(ts: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (diff === 0) return 'اليوم';
  if (diff === 1) return 'أمس';
  return dateFmt.format(ts);
}

export function greeting(now = new Date()): string {
  return now.getHours() < 12 ? 'صباح الخير يا أمي' : 'مساء الخير يا أمي';
}

/** The person bringing it, or a gentle stand-in before anyone has accepted. */
export const runnerName = (r: DeliveryRequest) => r.runner?.displayName ?? 'ابنك';

export const STATUS: Record<RequestStatus, string> = {
  pending: 'أُرسل',
  accepted: 'وافق',
  in_progress: 'في الطريق',
  delivered: 'وصل',
  declined: 'لم يُحضَر',
  cancelled: 'أُلغي',
};

export const PLACES = ['غرفتي', 'الصالة', 'المطبخ', 'فوق', 'تحت'];

export interface Item {
  key: string;
  /** The word on the button. */
  label: string;
  /** What the request says. */
  title: string;
  quickType: QuickType | null;
  priority: Priority;
  icon: LucideIcon;
  tone: 'water' | 'snack' | 'help' | 'medicine' | 'default';
}

/** The big buttons on the home screen. "شيء آخر" lets her write anything. */
export const ITEMS: Item[] = [
  { key: 'water', label: 'ماء', title: 'كوب ماء', quickType: 'water', priority: 'normal', icon: GlassWater, tone: 'water' },
  { key: 'tea', label: 'شاي', title: 'كوب شاي', quickType: null, priority: 'normal', icon: Coffee, tone: 'snack' },
  { key: 'food', label: 'أكل', title: 'شيء آكله', quickType: 'snack', priority: 'normal', icon: Cookie, tone: 'snack' },
  { key: 'medicine', label: 'دواء', title: 'دوائي', quickType: 'medicine', priority: 'high', icon: Pill, tone: 'medicine' },
  { key: 'help', label: 'تعال عندي', title: 'تعال عندي', quickType: 'help', priority: 'high', icon: HandHelping, tone: 'help' },
  { key: 'other', label: 'شيء آخر', title: '', quickType: null, priority: 'normal', icon: PenLine, tone: 'default' },
];

/** The icon for a request, from its shortcut or its words. */
export function itemFor(r: Pick<DeliveryRequest, 'title' | 'quickType'>): Item {
  return (
    ITEMS.find((i) => i.quickType && i.quickType === r.quickType) ??
    ITEMS.find((i) => i.key !== 'other' && i.title === r.title) ??
    ITEMS[ITEMS.length - 1]
  );
}

/** The pop-up shown in the app when something happens to one of her requests. */
export function updateTitle(type: string, r: DeliveryRequest | undefined): string | null {
  const who = r?.runner?.displayName ?? 'ابنك';
  switch (type) {
    case 'accepted':
      return `${who} وافق على طلبك`;
    case 'started':
      return 'طلبك في الطريق إليك';
    case 'eta_updated':
      return 'تغيّر وقت الوصول';
    case 'delivered':
      return 'وصل طلبك ✓';
    case 'declined':
      return `${who} لا يستطيع إحضاره الآن`;
    case 'cancelled':
      return 'أُلغي الطلب';
    default:
      return null;
  }
}

/** How long until it arrives, in plain words. Never a promise: the time is an estimate. */
export function etaText(r: DeliveryRequest, now: number): string | null {
  if (r.status !== 'accepted' && r.status !== 'in_progress') return null;
  if (!r.etaAt) return 'لم يُحدَّد وقت الوصول بعد';
  const left = r.etaAt - now;
  if (left <= 0) return 'من المفترض أن يصل الآن';
  if (left < 60_000) return 'يصل خلال أقل من دقيقة';
  return `يصل خلال حوالي ${minutes(Math.ceil(left / 60_000))}`;
}
