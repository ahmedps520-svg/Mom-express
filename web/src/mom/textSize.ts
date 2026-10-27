import { create } from 'zustand';
import { readJson, writeJson } from '../lib/storage';

// How big Mom wants the writing. Kept on the device, since it's about the screen.

export type TextSize = 'normal' | 'large' | 'xlarge';

const KEY = 'mx:mom-text-size';

const useStore = create<{ size: TextSize }>()(() => ({ size: readJson<TextSize>(KEY) ?? 'large' }));

export const useTextSize = () => useStore((s) => s.size);

export function setTextSize(size: TextSize): void {
  writeJson(KEY, size);
  useStore.setState({ size });
}
