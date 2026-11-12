import { useSyncExternalStore } from 'react';

/**
 * Carino's languages for the web screens: the same translations as the Flutter app
 * (app/assets/i18n/<code>.json, keyed by the English text), falling back to English.
 */
const files = import.meta.glob<Record<string, string>>('../../app/assets/i18n/*.json', { import: 'default' });
const SUPPORTED = ['en', 'pt-BR', 'de', 'fr', 'es', 'nl', 'it', 'pl'];

/** The language choices, each named in its own language. */
export const APP_LANGUAGES: [string, string][] = [
  ['', 'Automatic (phone language)'], ['en', 'English'], ['pt-BR', 'Português (Brasil)'], ['de', 'Deutsch'],
  ['fr', 'Français'], ['es', 'Español'], ['nl', 'Nederlands'], ['it', 'Italiano'], ['pl', 'Polski'],
];

let words: Record<string, string> = {};
let code = 'en';
let wanted = '\u0000';
const listeners = new Set<() => void>();

/** The language for a setting ('' = the browser's language when Carino has it). */
export function resolveLanguage(setting: string, browser = typeof navigator !== 'undefined' ? navigator.language : 'en') {
  if (setting && SUPPORTED.includes(setting)) return setting;
  const base = browser.split('-')[0].toLowerCase();
  if (base === 'pt') return 'pt-BR';
  return SUPPORTED.includes(base) ? base : 'en';
}

export async function setLanguage(setting: string) {
  if (setting === wanted) return;
  wanted = setting;
  const next = resolveLanguage(setting);
  let w: Record<string, string> = {};
  const load = files[`../../app/assets/i18n/${next}.json`];
  if (next !== 'en' && load) w = await load().catch(() => ({}));
  if (wanted !== setting) return;
  words = w;
  code = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((l) => l());
}

/** English UI text in the user's language; {0}, {1} … are filled from args. */
export function t(key: string, args?: unknown[]) {
  let s = words[key] ?? key;
  if (args) args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a ?? '')); });
  return s;
}

/** Re-renders when the language changes. */
export function useLanguage() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => code, () => code);
}
