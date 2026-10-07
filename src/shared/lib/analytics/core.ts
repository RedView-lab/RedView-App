/**
 * État de la mesure côté page : écran courant, contexte du compte (formule,
 * ancienneté, compte interne), file d'attente tant que le tracker n'est pas
 * chargé, anti-doublon et étranglement des événements fréquents, résumés
 * envoyés à la fermeture de la page. Rien ici ne lit ni n'envoie de donnée
 * personnelle : le contexte n'a que des catégories (voir beforeSend.ts).
 */

import type { AccountAgeBucket } from './buckets';
import type { BeforeSendContext } from './beforeSend';
import type { AnalyticsEvent } from './events';
import type { AnalyticsData } from './privacy';
import { ANALYTICS_SCREENS, ANALYTICS_SCREEN_TITLES, type AnalyticsScreen } from './screens';

type UmamiProps = Record<string, unknown>;

declare global {
  interface Window {
    umami?: {
      track: (
        eventOrProps?: string | UmamiProps | ((props: UmamiProps) => UmamiProps),
        eventData?: Record<string, string | number | boolean>,
      ) => unknown;
    };
  }
}

export type AnalyticsSurface = 'app' | 'viewer';

export interface AnalyticsAccountContext {
  /** Formule (`demo`, `founder`, `patron`…), jamais un id d'abonnement. */
  plan?: string;
  account_age?: AccountAgeBucket;
  /** Compte de l'équipe ou de test (libellé Appwrite `internal`) : rien ne part. */
  internal?: boolean;
}

/** Copie locale du contexte : le viewer LiDAR (autre page) et le démarrage suivant le relisent. */
const ANALYTICS_CONTEXT_STORAGE_KEY = 'rv:analytics-context';
const DEDUPE_WINDOW_MS = 1000;
const MAX_QUEUE = 100;

let surface: AnalyticsSurface = 'app';
let currentScreen: AnalyticsScreen = 'login';
let accountContext: AnalyticsAccountContext = readStoredContext();
let lastScreenSent: { screen: AnalyticsScreen; at: number } | null = null;
const lastEventAt = new Map<string, number>();
const throttledAt = new Map<string, number>();
const queue: Array<() => void> = [];
const pageHideSummaries = new Set<() => void>();

function readStoredContext(): AnalyticsAccountContext {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ANALYTICS_CONTEXT_STORAGE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const { plan, account_age, internal } = parsed as Record<string, unknown>;
    return {
      ...(typeof plan === 'string' && /^[a-z_]{1,20}$/.test(plan) ? { plan } : {}),
      ...(account_age === 'd0' || account_age === 'd1_7' || account_age === 'd8_30' || account_age === 'd30_plus' ? { account_age } : {}),
      ...(internal === true ? { internal } : {}),
    };
  } catch {
    return {};
  }
}

function persistContext(): void {
  try {
    if (Object.keys(accountContext).length === 0) localStorage.removeItem(ANALYTICS_CONTEXT_STORAGE_KEY);
    else localStorage.setItem(ANALYTICS_CONTEXT_STORAGE_KEY, JSON.stringify(accountContext));
  } catch {
    /* stockage bloqué : le contexte reste en mémoire pour cette page */
  }
}

export function setAnalyticsSurface(next: AnalyticsSurface): void {
  surface = next;
  if (next === 'viewer') currentScreen = 'viewer';
}

/** Complète le contexte du compte (formule connue plus tard que l'ancienneté, par exemple). */
export function setAnalyticsContext(patch: AnalyticsAccountContext): void {
  const next: AnalyticsAccountContext = { ...accountContext, ...patch };
  if (!next.internal) delete next.internal;
  accountContext = next;
  persistContext();
}

/** Déconnexion : plus de contexte de compte. */
export function clearAnalyticsContext(): void {
  accountContext = {};
  persistContext();
}

export function getBeforeSendContext(): BeforeSendContext {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const superProps: AnalyticsData = { surface };
  if (accountContext.plan) superProps.plan = accountContext.plan;
  if (accountContext.account_age) superProps.account_age = accountContext.account_age;
  const lang = root?.lang?.slice(0, 2);
  if (lang) superProps.lang = lang;
  const theme = root?.dataset.rvTheme;
  if (theme === 'light' || theme === 'dark') superProps.theme = theme;
  return {
    screen: currentScreen,
    superProps,
    excluded: accountContext.internal === true,
    origin: typeof location !== 'undefined' ? location.origin : 'https://app.redview.tech',
  };
}

function send(call: () => void): void {
  if (typeof window === 'undefined') return;
  if (window.umami) {
    try {
      call();
    } catch (error) {
      console.warn('[analytics] envoi impossible', error);
    }
    return;
  }
  // Tracker pas encore chargé (chargé au repos) ou bloqué : file bornée.
  if (queue.length < MAX_QUEUE) queue.push(call);
}

/** Appelé quand le script du tracker est chargé. */
export function flushAnalyticsQueue(): void {
  if (typeof window === 'undefined' || !window.umami) return;
  for (const call of queue.splice(0)) {
    try {
      call();
    } catch (error) {
      console.warn('[analytics] envoi impossible', error);
    }
  }
}

export function trackAnalyticsEvent(event: AnalyticsEvent): void {
  const data = 'data' in event ? (event.data as Record<string, string | number | boolean>) : undefined;
  const key = `${event.name}:${data ? JSON.stringify(data) : ''}`;
  const now = Date.now();
  const last = lastEventAt.get(key);
  // Double rendu (StrictMode), double clic : un seul événement.
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
  lastEventAt.set(key, now);
  if (lastEventAt.size > 200) lastEventAt.clear();
  send(() => window.umami?.track(event.name, data));
}

/** Au plus un événement par `key` et par `intervalMs` (recalculs de route en rafale…). */
export function trackAnalyticsEventThrottled(event: AnalyticsEvent, key: string, intervalMs: number): void {
  const now = Date.now();
  const last = throttledAt.get(key);
  if (last !== undefined && now - last < intervalMs) return;
  throttledAt.set(key, now);
  trackAnalyticsEvent(event);
}

/** Page vue virtuelle : l'écran affiché (jamais l'URL réelle, qui porte le nom du projet). */
export function trackScreen(screen: AnalyticsScreen): void {
  currentScreen = screen;
  const now = Date.now();
  if (lastScreenSent && lastScreenSent.screen === screen && now - lastScreenSent.at < DEDUPE_WINDOW_MS) return;
  lastScreenSent = { screen, at: now };
  const url = ANALYTICS_SCREENS[screen];
  const title = ANALYTICS_SCREEN_TITLES[screen];
  send(() => window.umami?.track((props) => ({ ...props, url, title })));
}

export function getCurrentAnalyticsScreen(): AnalyticsScreen {
  return currentScreen;
}

/**
 * Résumé envoyé à la fermeture de la page (`pagehide`, le tracker envoie en
 * `keepalive`) : compteurs agrégés plutôt qu'un événement par action.
 */
export function registerAnalyticsPageHideSummary(summary: () => void): () => void {
  pageHideSummaries.add(summary);
  return () => {
    pageHideSummaries.delete(summary);
  };
}

export function runAnalyticsPageHideSummaries(): void {
  for (const summary of pageHideSummaries) {
    try {
      summary();
    } catch (error) {
      console.warn('[analytics] résumé impossible', error);
    }
  }
}

/** Remise à zéro de l'état du module (tests). */
export function resetAnalyticsStateForTests(): void {
  surface = 'app';
  currentScreen = 'login';
  accountContext = {};
  lastScreenSent = null;
  lastEventAt.clear();
  throttledAt.clear();
  queue.length = 0;
  pageHideSummaries.clear();
}
