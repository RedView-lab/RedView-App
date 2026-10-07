/**
 * Mesure d'audience (Umami auto-hébergé, servi first-party sur /s/) : événements
 * ANONYMES — pas de cookie, pas d'`identify`, pas de replay de session (retiré
 * le 2026-10-07). Les données ne sont que des catégories, des tranches et des
 * valeurs arrondies, plus un contexte de compte grossier (formule, ancienneté
 * par tranche) ; le garde vie privée et le before-send (beforeSend.ts) filtrent
 * tout ce qui part. La rétention par compte se lit dans la base, sans suivre
 * personne : `npx tsx --env-file=.env scripts/activation-report.ts`.
 *
 * Ajouter un événement : son type dans events.ts, l'appel au point de passage,
 * et (s'il compte dans un entonnoir) scripts/umami/spec.ts. Voir docs/ANALYTICS.md.
 */

import type { AnalyticsEvent } from './events';

export * from './buckets';
export type * from './events';
export {
  clearAnalyticsContext,
  getCurrentAnalyticsScreen,
  registerAnalyticsPageHideSummary,
  setAnalyticsContext,
  trackAnalyticsEvent,
  trackAnalyticsEventThrottled,
  trackScreen,
} from './core';
export type { AnalyticsScreen } from './screens';
export { initAnalytics } from './loader';

/**
 * Attributs d'un bouton mesuré au clic par le tracker (`data-umami-event`),
 * typés comme les autres événements : `<button {...analyticsAttrs({ name: 'freecam_entered' })}>`.
 */
export function analyticsAttrs(event: AnalyticsEvent): Record<string, string> {
  const attrs: Record<string, string> = { 'data-umami-event': event.name };
  if ('data' in event && event.data) {
    for (const [key, value] of Object.entries(event.data)) attrs[`data-umami-event-${key}`] = String(value);
  }
  return attrs;
}
