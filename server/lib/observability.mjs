// ---------------------------------------------------------------------------
// Erreurs du serveur de prod → GlitchTip (SDK Sentry pour Node, protocole
// compatible). Actif seulement si SENTRY_DSN_SERVER est défini (projet
// GlitchTip distinct du front). Erreurs seulement : pas de tracing.
//
// Le contexte (route normalisée, X-Request-ID, méthode) est posé dans un
// scope local à la capture (`withScope`) : rien ne fuit d'une requête à une
// requête concurrente. Aucune donnée personnelle : ni en-têtes, ni cookies,
// ni query, ni corps, ni IP.
// ---------------------------------------------------------------------------
import * as Sentry from '@sentry/node';

import { resolveBuildId } from './build-id.mjs';

let enabled = false;

/** Retire de l'événement tout ce qui pourrait porter un secret ou une donnée personnelle. */
export function scrubServerEvent(event) {
  if (event.request) {
    const { method, url } = event.request;
    event.request = {
      method,
      url: typeof url === 'string' ? url.split('?')[0] : undefined,
    };
  }
  if (event.user) event.user = undefined;
  return event;
}

export function initServerObservability(env = process.env) {
  const dsn = env.SENTRY_DSN_SERVER;
  if (enabled || !dsn) return enabled;
  Sentry.init({
    dsn,
    release: resolveBuildId(env),
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production',
    sendDefaultPii: false,
    beforeSend: scrubServerEvent,
  });
  enabled = true;
  return enabled;
}

/**
 * @param {unknown} error
 * @param {{ route?: string, requestId?: string, method?: string }} [context]
 */
export function captureServerError(error, context = {}) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context.route) scope.setTag('route', context.route);
    if (context.method) scope.setTag('method', context.method);
    if (context.requestId) scope.setTag('request_id', context.requestId);
    Sentry.captureException(error);
  });
}

/** Envoie les événements en attente (arrêt du conteneur). */
export async function flushServerObservability(timeoutMs = 2000) {
  if (!enabled) return;
  await Sentry.close(timeoutMs);
}
