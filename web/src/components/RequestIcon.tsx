import {
  BatteryCharging,
  Coffee,
  Cookie,
  GlassWater,
  HandHelping,
  Package,
  Pill,
  Shirt,
  Utensils,
  type LucideIcon,
} from 'lucide-react';
import type { DeliveryRequest } from '../../../shared/types.js';

type Tone = 'water' | 'snack' | 'help' | 'medicine' | 'default';

const BY_TYPE: Record<NonNullable<DeliveryRequest['quickType']>, { icon: LucideIcon; tone: Tone }> = {
  water: { icon: GlassWater, tone: 'water' },
  snack: { icon: Cookie, tone: 'snack' },
  help: { icon: HandHelping, tone: 'help' },
  medicine: { icon: Pill, tone: 'medicine' },
};

const KEYWORDS: [RegExp, LucideIcon, Tone][] = [
  [/\b(water|drink|juice)\b/i, GlassWater, 'water'],
  [/\b(snack|cookie|biscuit|chips|fruit|chocolate)\b/i, Cookie, 'snack'],
  [/\b(medicine|pill|tablet|meds|vitamin)s?\b/i, Pill, 'medicine'],
  [/\b(help|hand|assist)\b/i, HandHelping, 'help'],
  [/\b(tea|coffee)\b/i, Coffee, 'snack'],
  [/\b(food|meal|lunch|dinner|breakfast|sandwich)\b/i, Utensils, 'snack'],
  [/\b(charger|charging|cable|phone|battery)\b/i, BatteryCharging, 'default'],
  [/\b(blanket|sweater|jumper|cardigan|socks|clothes|shirt|jacket)\b/i, Shirt, 'default'],
  // Mom writes in Arabic (\b doesn't work with Arabic letters, so these match anywhere).
  [/ماء|مويه|موية|عصير/, GlassWater, 'water'],
  [/شاي|قهوة|قهوه/, Coffee, 'snack'],
  [/دواء|دوا|حبوب|علاج/, Pill, 'medicine'],
  [/تعال|ساعد|مساعدة/, HandHelping, 'help'],
  [/أكل|اكل|طعام|وجبة|فطور|غداء|عشاء|سندويش|فاكهة|بسكويت/, Utensils, 'snack'],
  [/شاحن|جوال|تلفون|هاتف/, BatteryCharging, 'default'],
  [/بطانية|ملابس|جاكيت|شال/, Shirt, 'default'],
];

export function iconFor(request: Pick<DeliveryRequest, 'quickType' | 'title'>): { icon: LucideIcon; tone: Tone } {
  if (request.quickType) return BY_TYPE[request.quickType];
  for (const [re, icon, tone] of KEYWORDS) if (re.test(request.title)) return { icon, tone };
  return { icon: Package, tone: 'default' };
}

export function RequestIcon({ request, small = false }: { request: Pick<DeliveryRequest, 'quickType' | 'title'>; small?: boolean }) {
  const { icon: Icon, tone } = iconFor(request);
  return (
    <span className={`bubble tone-${tone}${small ? ' bubble-sm' : ''}`} aria-hidden="true">
      <Icon />
    </span>
  );
}
