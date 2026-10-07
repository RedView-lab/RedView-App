/**
 * Thème de l'interface (clair / sombre).
 *
 * La préférence vient des réglages globaux (« Préférence d'affichage » :
 * système, clair, sombre — `displayMode` dans PROJECT_BROWSER_SETTINGS_STORAGE_KEY).
 * Le thème résolu est posé sur <html data-rv-theme="light|dark"> ; les
 * couleurs suivent les tokens de `shared/styles/theme.css` (et `light-dark()`,
 * d'où le `color-scheme` posé au même endroit).
 *
 * Le code qui peint lui-même (canvas, sprites, WebGL, styles inline calculés)
 * lit le thème avec `useAppTheme()` ou `getAppTheme()` / `subscribeAppTheme()`.
 */
import { useSyncExternalStore } from 'react';

import { PROJECT_BROWSER_SETTINGS_STORAGE_KEY } from '@/shared/i18n/config/types';

export type AppThemePreference = 'system' | 'light' | 'dark';
export type AppTheme = 'light' | 'dark';

export const DEFAULT_APP_THEME_PREFERENCE: AppThemePreference = 'system';

const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

export function isAppThemePreference(value: unknown): value is AppThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readAppThemePreference(): AppThemePreference {
  if (typeof window === 'undefined') return DEFAULT_APP_THEME_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { displayMode?: unknown }) : null;
    return isAppThemePreference(parsed?.displayMode) ? parsed.displayMode : DEFAULT_APP_THEME_PREFERENCE;
  } catch {
    return DEFAULT_APP_THEME_PREFERENCE;
  }
}

function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(LIGHT_SCHEME_QUERY).matches
    : false;
}

function resolveAppTheme(preference: AppThemePreference): AppTheme {
  if (preference === 'system') return systemPrefersLight() ? 'light' : 'dark';
  return preference;
}

let preference: AppThemePreference = DEFAULT_APP_THEME_PREFERENCE;
let theme: AppTheme = 'dark';
const listeners = new Set<() => void>();

function apply(nextTheme: AppTheme): void {
  const changed = nextTheme !== theme;
  theme = nextTheme;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (root.dataset.rvTheme !== nextTheme) root.dataset.rvTheme = nextTheme;
  }
  if (changed) {
    for (const listener of listeners) listener();
  }
}

/** Choix fait dans les réglages : appliqué tout de suite (l'écriture du stockage reste au panneau). */
export function setAppThemePreference(next: AppThemePreference): void {
  preference = next;
  apply(resolveAppTheme(next));
}

function getAppTheme(): AppTheme {
  return theme;
}

function subscribeAppTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppTheme(): AppTheme {
  return useSyncExternalStore(subscribeAppTheme, getAppTheme, getAppTheme);
}

let initialized = false;

/**
 * À appeler avant le premier rendu (main.tsx, viewer LiDAR) : pose le thème
 * sans flash, puis suit le système (préférence « système ») et les réglages
 * changés dans un autre onglet.
 */
export function initAppTheme(): AppTheme {
  preference = readAppThemePreference();
  theme = resolveAppTheme(preference);
  if (typeof document !== 'undefined') document.documentElement.dataset.rvTheme = theme;
  if (initialized || typeof window === 'undefined') return theme;
  initialized = true;

  window.matchMedia?.(LIGHT_SCHEME_QUERY).addEventListener?.('change', () => {
    if (preference === 'system') apply(resolveAppTheme('system'));
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== PROJECT_BROWSER_SETTINGS_STORAGE_KEY) return;
    setAppThemePreference(readAppThemePreference());
  });
  return theme;
}
