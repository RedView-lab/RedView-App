import {
  countBucket,
  registerAnalyticsPageHideSummary,
  roundTo,
  trackAnalyticsEvent,
  trackAnalyticsEventThrottled,
  type RouteKind,
} from '@/shared/lib/analytics';

import { isActivityPresetId } from '../../lib/project/profilePresets';
import { classifyBrouterError } from '../../lib/brouter/api/brouterErrorMessage';

/**
 * Mesure d'audience du routage : latence, longueur et profil des calculs
 * (au plus un événement par itinéraire et par sorte toutes les 15 s — un
 * glisser-déposer en déclenche des dizaines), catégorie des échecs, et le
 * volume des retouches locales résumé à la fermeture de la page.
 */

const ROUTE_EVENT_INTERVAL_MS = 15_000;

const patchesByItinerary = new Map<string, number>();
let summaryRegistered = false;

function ensureEditingSummary(): void {
  if (summaryRegistered) return;
  summaryRegistered = true;
  registerAnalyticsPageHideSummary(() => {
    if (patchesByItinerary.size === 0) return;
    let patches = 0;
    for (const count of patchesByItinerary.values()) patches += count;
    trackAnalyticsEvent({
      name: 'route_editing_summary',
      data: { routes: countBucket(patchesByItinerary.size), patches: countBucket(patches) },
    });
    patchesByItinerary.clear();
  });
}

/** Profil mesuré : le nom d'un préréglage d'activité, sinon `custom` (jamais le nom donné par l'utilisateur). */
function routeProfileCategory(profileId: string | null | undefined): string {
  return isActivityPresetId(profileId) ? profileId : 'custom';
}

export function trackRouteComputed(
  kind: RouteKind,
  itinerary: { id: string; profileId?: string | null },
  route: { distanceM: number; ascentM: number },
  ms: number,
): void {
  if (kind === 'patch') {
    ensureEditingSummary();
    patchesByItinerary.set(itinerary.id, (patchesByItinerary.get(itinerary.id) ?? 0) + 1);
  }
  trackAnalyticsEventThrottled(
    {
      name: 'route_calculated',
      data: {
        kind,
        distance_km: roundTo(route.distanceM / 1000, 10),
        elevation_m: roundTo(route.ascentM, 100),
        ms: roundTo(ms, 100),
        profile: routeProfileCategory(itinerary.profileId),
      },
    },
    `route:${kind}:${itinerary.id}`,
    ROUTE_EVENT_INTERVAL_MS,
  );
}

export function trackRouteFailed(kind: RouteKind, error: unknown): void {
  trackAnalyticsEvent({ name: 'route_failed', data: { kind, reason: classifyBrouterError(error) } });
}
