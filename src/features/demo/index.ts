// ---------------------------------------------------------------------------
// Demo mode — public-facing showcase configuration.
//
// Goal: when the app is opened in "demo" context (public landing page,
// marketing video capture, conference booth), force a Mapbox-billing-friendly
// configuration to keep usage well below the free tiers:
//   - Basemap locked to `topographic` (vector style → 0 Raster Tiles SKU)
//   - Satellite & all raster bases hidden from the basemap selector
//
// Activation: either of the following turns demo mode on globally for the
// session.
//   1. URL query flag:   `?demo=1`   (also persists for the tab via
//      sessionStorage so subsequent navigations stay in demo mode)
//   2. Build-time env var: `VITE_DEMO_MODE=1` (Vercel preview / staging
//      deployments dedicated to public demo routes)
// ---------------------------------------------------------------------------

import type { BasemapId } from '@/features/controlPanel/types';

const SESSION_STORAGE_KEY = 'redview:demo-mode';
const QUERY_PARAM = 'demo';

function readQueryFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get(QUERY_PARAM);
    return flag === '1' || flag === 'true';
  } catch {
    return false;
  }
}

function readSessionFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistSessionFlag(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, '1');
  } catch {
    /* private mode / quota — non-fatal */
  }
}

function readBuildFlag(): boolean {
  const raw = import.meta.env?.VITE_DEMO_MODE;
  return raw === '1' || raw === 'true';
}

let cached: boolean | null = null;

/**
 * Returns true when the app should run in demo mode.
 * Cached for the lifetime of the page (demo mode is sticky).
 */
export function isDemoMode(): boolean {
  if (cached !== null) return cached;
  if (readBuildFlag()) {
    cached = true;
    return true;
  }
  if (readQueryFlag()) {
    persistSessionFlag();
    cached = true;
    return true;
  }
  cached = readSessionFlag();
  return cached;
}

/** The basemap forced in demo mode — never satellite-raster. */
export const DEMO_BASEMAP_ID: BasemapId = 'topographic';

/**
 * Returns the basemap id the demo mode is enforcing, or null when demo
 * mode is off and the user's choice should be honoured.
 */
export function getDemoEnforcedBasemapId(): BasemapId | null {
  return isDemoMode() ? DEMO_BASEMAP_ID : null;
}

/** True when the basemap selector UI should be hidden in demo mode. */
export function shouldHideBasemapSelector(): boolean {
  return isDemoMode();
}

/**
 * Defense-in-depth guard for any function that would mutate user data, hit
 * Supabase storage, or perform an action a public-demo visitor must NEVER
 * be able to trigger. Throws synchronously so the caller bails before the
 * network round-trip — the UI layer can additionally hide the button, but
 * even if a power user re-enables it via DevTools the action still fails.
 */
export function assertNotDemo(action: string): void {
  if (isDemoMode()) {
    throw new Error(`[demo] action blocked in demo mode: ${action}`);
  }
}

/**
 * Synthetic session used when the dashboard is mounted in demo mode.
 * The id is a fixed sentinel so any code that accidentally tries to write
 * `user_id = DEMO_USER_ID` to Postgres will be rejected by RLS (no row
 * exists for this id, no policy matches a non-authenticated supabase-js
 * client). The email is purely cosmetic for the dashboard chrome.
 */
export const DEMO_USER_ID = '00000000-0000-0000-0000-000000000000';
export const DEMO_USER_EMAIL = 'demo@redview.app';

export interface DemoSession {
  user: { id: string; email: string };
}

export function buildDemoSession(): DemoSession {
  return { user: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL } };
}
