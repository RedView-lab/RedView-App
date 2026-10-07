import { useEffect, useRef } from 'react';

import { locateRoutePointAtX } from '@/features/centerPanel/components/chart/series/builders';
import { useProjectStore } from '@/features/itineraryPanel/context/ProjectStore/hooks';

import { useLivePresenceOptional } from '../context/LivePresenceContext';

/**
 * Pont entre la présence en direct et le projet (monté dans le ProjectProvider,
 * ne rend rien) :
 *  - publie l'itinéraire actif de cet éditeur ;
 *  - en suivi, passe sur l'itinéraire actif de l'éditeur suivi (comme le
 *    changement de page de Figma ; changement de vue seule, rien n'est écrit
 *    dans le document) ; en choisir un autre soi-même arrête le suivi ;
 *  - situe sur la trace le point que les autres survolent sur leur graphique.
 */
export function LivePresenceBridge() {
  const live = useLivePresenceOptional();
  const { project, setProject } = useProjectStore();
  const publishActiveItinerary = live?.publishActiveItinerary;
  const setChartPointResolver = live?.setChartPointResolver;
  const stopFollowing = live?.stopFollowing;
  const activeItineraryId = project.activeItineraryId || null;
  const { itineraries } = project;

  useEffect(() => {
    publishActiveItinerary?.(activeItineraryId);
  }, [activeItineraryId, publishActiveItinerary]);

  const following = !!live?.following;
  const leaderItineraryId = live?.followTarget?.activeItineraryId ?? null;
  const leaderItineraryKnown = !!leaderItineraryId && itineraries.some((itinerary) => itinerary.id === leaderItineraryId);
  /** Itinéraire mis par le suivi (l'utilisateur en choisit un autre : il reprend la main). */
  const appliedRef = useRef<string | null>(null);
  /** Dernier itinéraire de l'éditeur suivi appliqué : on ne le réimpose pas après un choix de l'utilisateur. */
  const lastLeaderRef = useRef<string | null>(null);

  // Avant l'application ci-dessous : compare au dernier itinéraire mis par le suivi.
  useEffect(() => {
    if (!following) return;
    const applied = appliedRef.current;
    if (applied !== null && activeItineraryId !== applied) stopFollowing?.();
  }, [activeItineraryId, following, stopFollowing]);

  useEffect(() => {
    if (!following) {
      appliedRef.current = null;
      lastLeaderRef.current = null;
      return;
    }
    if (!leaderItineraryId || !leaderItineraryKnown || lastLeaderRef.current === leaderItineraryId) return;
    lastLeaderRef.current = leaderItineraryId;
    appliedRef.current = leaderItineraryId;
    if (activeItineraryId !== leaderItineraryId) setProject((previous) => ({ ...previous, activeItineraryId: leaderItineraryId }));
  }, [activeItineraryId, following, leaderItineraryId, leaderItineraryKnown, setProject]);

  useEffect(() => {
    if (!setChartPointResolver) return;
    setChartPointResolver((itineraryId, distanceM) => {
      const itinerary = itineraries.find((candidate) => candidate.id === itineraryId);
      const points = itinerary?.gpxRoute?.points;
      if (!itinerary || itinerary.visible === false || !points || points.length < 2) return null;
      const point = locateRoutePointAtX(points, null, 'distance', distanceM / 1000);
      return point ? [point.lon, point.lat] : null;
    });
  }, [itineraries, setChartPointResolver]);

  return null;
}
