/**
 * Dernier rempart avant chaque envoi du tracker Umami (`data-before-send`) :
 * pages vues, événements typés, clics `data-umami-event` et Web Vitals passent
 * tous ici. Fonction pure (testée) :
 *  - l'URL devient l'écran (`/editor`, `/projects`…) ; de la query, seuls
 *    `utm_*` et `ref` restent (acquisition) — jamais un `secret` de lien de
 *    réinitialisation, un e-mail ou un identifiant de clic publicitaire ;
 *  - le titre devient celui de l'écran (le titre réel porte le nom du projet) ;
 *  - le referrer est réduit à son origine, et retiré quand il vient de l'app
 *    elle-même ou du rebond OAuth ;
 *  - les données d'événement reçoivent le contexte commun puis le garde vie
 *    privée ; un nom d'événement hors format est refusé ;
 *  - noms, propriétés et valeurs partent en français courant (labels.ts) :
 *    c'est ce qu'affiche Umami à l'équipe ;
 *  - jamais d'`identify` ni d'id distinct ; tout est coupé pour un compte interne.
 */

import { eventLabel, toDisplayData } from './labels';
import { EVENT_NAME_PATTERN, sanitizeAnalyticsData, type AnalyticsData } from './privacy';
import { ANALYTICS_SCREENS, ANALYTICS_SCREEN_TITLES, screenForPath, type AnalyticsScreen } from './screens';

export interface UmamiPayload {
  url?: string;
  title?: string;
  referrer?: string;
  name?: string;
  data?: unknown;
  id?: string;
  [key: string]: unknown;
}

export interface BeforeSendContext {
  /** Écran affiché au moment de l'envoi. */
  screen: AnalyticsScreen;
  /** Contexte ajouté à chaque événement (formule, ancienneté, langue, thème…). */
  superProps: AnalyticsData;
  /** Compte interne (équipe, comptes de test) : rien ne part. */
  excluded: boolean;
  /** Origine de l'app (`https://app.redview.tech`). */
  origin: string;
}

const KEPT_QUERY_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];
const PROJECT_PATH_PREFIX = '/project/';
const BOUNCE_REFERRER_HOSTS = new Set(['accounts.google.com', 'appwrite.redview.tech']);

function parseUrl(value: string | undefined, origin: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value, origin);
  } catch {
    return null;
  }
}

function screenOf(url: URL | null, current: AnalyticsScreen): AnalyticsScreen {
  if (!url) return current;
  const virtual = screenForPath(url.pathname);
  if (virtual) return virtual;
  if (url.pathname.startsWith(PROJECT_PATH_PREFIX)) return 'editor';
  return current;
}

function keptQuery(url: URL | null): string {
  if (!url) return '';
  const kept = new URLSearchParams();
  for (const key of KEPT_QUERY_PARAMS) {
    const value = url.searchParams.get(key);
    if (value && /^[\w.-]{1,64}$/.test(value)) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : '';
}

/** Origine d'un referrer externe, ou chaîne vide (app elle-même, rebond OAuth, illisible). */
export function sanitizeReferrer(referrer: string | undefined, origin: string): string {
  if (!referrer || referrer.startsWith('/')) return '';
  const url = parseUrl(referrer, origin);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return '';
  if (url.origin === origin || BOUNCE_REFERRER_HOSTS.has(url.hostname)) return '';
  return url.origin;
}

export function prepareUmamiPayload(
  type: string,
  payload: UmamiPayload | null | undefined,
  context: BeforeSendContext,
): UmamiPayload | null {
  if (!payload || context.excluded || type === 'identify') return null;

  const url = parseUrl(payload.url, context.origin);
  const screen = screenOf(url, context.screen);
  const next: UmamiPayload = {
    ...payload,
    url: `${ANALYTICS_SCREENS[screen]}${keptQuery(url)}`,
    title: ANALYTICS_SCREEN_TITLES[screen],
    referrer: sanitizeReferrer(payload.referrer, context.origin),
  };
  delete next.id;

  if (type === 'event' && typeof payload.name === 'string') {
    if (!EVENT_NAME_PATTERN.test(payload.name)) return null;
    const merged = {
      ...context.superProps,
      ...(payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {}),
    };
    const { data } = sanitizeAnalyticsData(merged);
    next.name = eventLabel(payload.name) ?? payload.name;
    if (data) next.data = toDisplayData(data);
    else delete next.data;
  } else {
    // Page vue ou Web Vitals : pas de données libres.
    delete next.data;
    delete next.name;
  }
  return next;
}
