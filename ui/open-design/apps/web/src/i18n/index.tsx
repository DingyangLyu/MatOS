'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { getOpenDesignHost } from '@open-design/host';
import { LOCALES, type Dict, type Locale } from './types';

export { LOCALES, LOCALE_LABEL } from './types';
export type { Locale } from './types';

type DictKey = keyof Dict;

const INITIAL_DICTS: Partial<Record<Locale, Dict>> = {
  en,
  'zh-CN': zhCN,
};

const DICT_LOADERS: Partial<Record<Locale, () => Promise<Dict>>> = {
  en: async () => en,
  'zh-CN': async () => zhCN,
  'zh-TW': async () => (await import('./locales/zh-TW')).zhTW,
};

const LS_KEY = 'open-design:locale';
// Marker that says "the value in LS_KEY came from a deliberate user
// action through setLocale, not from some auto-detection path". Only
// values tagged this way win over the desktop host's injected OS
// locale, so a stale auto-detected pick can't pin the app forever once
// the user changes their system language.
const LS_SOURCE_KEY = 'open-design:locale-source';
const MANUAL_LOCALE_SOURCE = 'manual';

export function resolveSystemLocale(languages: readonly string[]): Locale | null {
  const supported = LOCALES as readonly string[];
  for (const raw of languages) {
    const normalized = raw.trim();
    if (!normalized) continue;

    const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    const [language, regionOrScript] = normalized.toLowerCase().split('-');
    if (language === 'zh') {
      if (regionOrScript === 'hant' || regionOrScript === 'tw' || regionOrScript === 'hk' || regionOrScript === 'mo') {
        return 'zh-TW';
      }
      return 'zh-CN';
    }

    const baseMatch = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language);
    if (baseMatch && supported.includes(baseMatch)) return baseMatch;
  }
  return null;
}

// Read the OS locale the desktop host attached to its client descriptor.
// Packaged desktop builds need this because Chromium otherwise reports
// en-US through navigator.language regardless of the OS setting. We go
// through `getOpenDesignHost` rather than reading the bridge global by
// name so the web/preload boundary stays single-source (see the
// `host bridge boundary` guard test).
function readDesktopHostOsLocale(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const host = getOpenDesignHost();
  const value = host?.client?.osLocale;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// First-run defaults to the user's OS / browser language when possible.
// Priority: explicit user pick saved to localStorage (only when tagged
// as manual) > OS locale that the desktop host injected (packaged
// Electron) > navigator.languages > 'en'. The source tag matters
// because untagged localStorage values are treated as legacy /
// auto-detected — they don't override a fresh OS locale read.
// Exported so tests can pin the priority chain without spinning up the
// full I18nProvider.
export function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  let storedLocale: string | null = null;
  let storedSource: string | null = null;
  try {
    storedLocale = window.localStorage.getItem(LS_KEY);
    storedSource = window.localStorage.getItem(LS_SOURCE_KEY);
  } catch {
    /* ignore */
  }
  if (
    storedSource === MANUAL_LOCALE_SOURCE &&
    storedLocale &&
    (LOCALES as string[]).includes(storedLocale)
  ) {
    return storedLocale as Locale;
  }
  const hostOsLocale = readDesktopHostOsLocale();
  if (hostOsLocale) {
    const fromHost = resolveSystemLocale([hostOsLocale]);
    if (fromHost) return fromHost;
  }
  const detected = resolveSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );
  return detected ?? 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

interface ProviderProps {
  initial?: Locale;
  children: ReactNode;
}

const RTL_LOCALES: Locale[] = ['ar', 'fa'];

export function I18nProvider({ initial, children }: ProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initial && LOCALES.includes(initial) ? initial : detectInitialLocale());
  const [dicts, setDicts] = useState<Partial<Record<Locale, Dict>>>(INITIAL_DICTS);

  // Keep <html lang="…" dir="…"> in sync so screen readers and CSS hooks
  // pick the right language token and direction without each component
  // having to set it itself.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('lang', locale);
      document.documentElement.setAttribute('dir', dir);
    }
  }, [locale]);

  useEffect(() => {
    if (dicts[locale]) return undefined;
    let cancelled = false;
    void (DICT_LOADERS[locale] ?? DICT_LOADERS.en!)()
      .then((dict) => {
        if (cancelled) return;
        setDicts((current) => {
          if (current[locale]) return current;
          return { ...current, [locale]: dict };
        });
      })
      .catch((error) => {
        console.warn(`Failed to load locale dictionary: ${locale}`, error);
      });
    return () => {
      cancelled = true;
    };
  }, [dicts, locale]);



  const setLocale = useCallback((next: Locale) => {
    if (!LOCALES.includes(next)) next = 'en';
    setLocaleState(next);
    try {
      window.localStorage.setItem(LS_KEY, next);
      // Marker so detectInitialLocale knows this came from a deliberate
      // user action and should beat the desktop host's OS locale.
      window.localStorage.setItem(LS_SOURCE_KEY, MANUAL_LOCALE_SOURCE);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>): string => {
      const dict = dicts[locale] ?? en;
      const raw = dict[key] ?? en[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
        const v = vars[name];
        return v == null ? `{${name}}` : String(v);
      });
    },
    [dicts, locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fall back to a stand-alone English translator when no provider is
    // mounted (e.g. an isolated test). This keeps the API safe to call
    // without requiring every callsite to wrap in a provider.
    return {
      locale: 'en',
      setLocale: () => { },
      t: (key, vars) => {
        const raw = en[key] ?? key;
        if (!vars) return raw;
        return raw.replace(/\{(\w+)\}/g, (_, n: string) => {
          const v = vars[n];
          return v == null ? `{${n}}` : String(v);
        });
      },
    };
  }
  return ctx;
}

// Convenience for components that only need the translator function.
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
