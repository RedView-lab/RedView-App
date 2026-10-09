/**
 * Chargement du tracker Umami, first-party : `/s/x.js` et `/s/api/send` sont
 * servis par le nginx de l'hôte d'app.redview.tech (server/vps/nginx-stats.conf),
 * même origine que l'app — CSP `'self'`, pas d'origine tierce.
 *
 * Jamais en développement ni hors du domaine de prod (le dev polluait les
 * statistiques) ; les benchs le forcent avec `localStorage['rv:analytics-test']`
 * et servent leur propre faux tracker. Injecté au repos après le premier rendu :
 * les événements émis avant attendent dans la file (core.ts), les Web Vitals
 * sont relus dans le tampon du navigateur.
 */

import { prepareUmamiPayload, type UmamiPayload } from './beforeSend';
import {
  flushAnalyticsQueue,
  getBeforeSendContext,
  runAnalyticsPageHideSummaries,
  setAnalyticsSurface,
  type AnalyticsSurface,
} from './core';
import { isAnalyticsOptedOut } from './optOut';

const UMAMI_WEBSITE_ID = '794b9933-1d87-4e8c-af69-a09982cc2353';
const UMAMI_SCRIPT_SRC = '/s/x.js';
const ANALYTICS_HOSTS = ['app.redview.tech'];
const ANALYTICS_TEST_FLAG_KEY = 'rv:analytics-test';
const BEFORE_SEND_GLOBAL = '__rvUmamiBeforeSend';

declare global {
  interface Window {
    __rvUmamiBeforeSend?: (type: string, payload: UmamiPayload) => UmamiPayload | null;
  }
}

let initialized = false;

function readTestFlag(): boolean {
  try {
    return localStorage.getItem(ANALYTICS_TEST_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Tag Umami = release (comparer Web Vitals et usages d'un déploiement à l'autre). */
export function releaseTag(buildId: string): string {
  const cleaned = buildId.replace(/[^\w.-]/g, '');
  return cleaned.slice(0, 12) || 'unknown';
}

export function initAnalytics({ surface, release }: { surface: AnalyticsSurface; release: string }): void {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return;
  initialized = true;
  setAnalyticsSurface(surface);
  if (!import.meta.env.PROD) return;
  const testMode = readTestFlag();
  if (!testMode && !ANALYTICS_HOSTS.includes(window.location.hostname)) return;
  // Mesure refusée sur cet appareil (Réglages) : le tracker n'est même pas chargé.
  if (isAnalyticsOptedOut()) return;

  window[BEFORE_SEND_GLOBAL] = (type, payload) => prepareUmamiPayload(type, payload, getBeforeSendContext());
  window.addEventListener('pagehide', runAnalyticsPageHideSummaries);

  const inject = () => {
    const script = document.createElement('script');
    script.src = UMAMI_SCRIPT_SRC;
    script.async = true;
    script.dataset.websiteId = UMAMI_WEBSITE_ID;
    script.dataset.autoPageview = 'false';
    script.dataset.performance = 'true';
    script.dataset.doNotTrack = 'true';
    script.dataset.excludeHash = 'true';
    script.dataset.tag = releaseTag(release);
    script.dataset.beforeSend = BEFORE_SEND_GLOBAL;
    if (!testMode) script.dataset.domains = ANALYTICS_HOSTS.join(',');
    script.addEventListener('load', flushAnalyticsQueue);
    document.head.appendChild(script);
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(inject, { timeout: 4000 });
  else setTimeout(inject, 1500);
}
