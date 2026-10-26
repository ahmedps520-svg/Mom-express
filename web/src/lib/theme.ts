import type { ThemePreference } from '../../../shared/types.js';
import { keys, readJson, writeJson } from './storage';

const media = window.matchMedia('(prefers-color-scheme: dark)');
let current: ThemePreference = readJson<ThemePreference>(keys.theme) ?? 'system';

function resolve(pref: ThemePreference): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}

function paint(): void {
  const mode = resolve(current);
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = mode === 'dark' ? '#161012' : '#fff8f4';
    meta.removeAttribute('media');
  }
}

/** Applies the saved theme straight away, before the first render, to avoid a flash. */
export function initTheme(): void {
  paint();
  media.addEventListener('change', () => {
    if (current === 'system') paint();
  });
}

export function applyTheme(pref: ThemePreference): void {
  current = pref;
  writeJson(keys.theme, pref);
  paint();
}
