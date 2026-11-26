/**
 * Lightweight vanilla-TS i18n — no framework, no async loading.
 *
 * - `t(key)` resolves a dot-key against the active bundle, falling back
 *   to English and finally to the key itself (so a missing translation
 *   degrades visibly but never crashes).
 * - The active language persists in localStorage (`omg.lang.v1`) and
 *   defaults to the browser language when it is Vietnamese.
 * - `setLanguage()` notifies subscribers so the shell can re-render
 *   chrome strings; pages re-render on the next state `emit()`.
 *
 * Only surfaces touched by W0 (shell / nav / first-run / confirm modal /
 * dashboard home / status vocabulary) are translated so far — legacy
 * page strings stay English until their modules are migrated.
 */

import { en, type StringKey, type Strings } from './en.ts';
import { vi } from './vi.ts';

export type Language = 'en' | 'vi';
export const LANGUAGES: readonly Language[] = ['en', 'vi'];

export const LANGUAGE_STORAGE_KEY = 'omg.lang.v1';

const BUNDLES: Record<Language, Strings> = { en, vi };

/** Minimal Storage surface — localStorage satisfies it; tests inject a Map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function detectLanguage(storage: KeyValueStorage | null): Language {
  if (storage) {
    try {
      const saved = storage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved === 'en' || saved === 'vi') return saved;
    } catch {
      /* fall through to browser detection */
    }
  }
  if (typeof navigator !== 'undefined') {
    const lang = (navigator.language || '').toLowerCase();
    if (lang.startsWith('vi')) return 'vi';
  }
  return 'en';
}

let current: Language = detectLanguage(defaultStorage());
if (typeof document !== 'undefined') {
  document.documentElement.lang = current;
}
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  try {
    defaultStorage()?.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    /* private mode — preference just won't persist */
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }
  for (const fn of listeners) fn();
}

/** Re-run `fn` whenever the language changes. Returns an unsubscribe. */
export function onLanguageChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate a key. Falls back to English, then to the key itself.
 * `{name}` placeholders in the value are interpolated from `vars`.
 */
export function t(key: StringKey | string, vars?: Record<string, string>): string {
  let s: string | undefined = BUNDLES[current][key as StringKey];
  if (s === undefined) s = en[key as StringKey];
  if (s === undefined) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}
