import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import {
  clearRouteHoverPreview,
  setRouteHoverPreview,
} from '@/features/itineraryPanel/lib/route-layer';
import { haversineRouteDistanceM } from '@/features/itineraryPanel/lib/routes';
import {
  findSplitProjectionForMapHover,
  type RouteSnapPoint,
} from '../tools/routeSplit/routeSnap';

/**
 * Marqueur d'aperçu au survol partagé par les outils du panneau central.
 *
 * Tant qu'un outil est armé, ceci attache un écouteur `mousemove` qui affiche un
 * seul marqueur ponctuel sur le tracé, montrant où tombera le prochain clic :
 *
 *  - **Mode découpe** (`snap` fourni) : le marqueur s'accroche au sommet du tracé
 *    le plus proche. Dans la tolérance de clic il est à pleine intensité ; en
 *    dehors il s'atténue pour signaler « un clic ici ne fait rien » tout en
 *    suivant le curseur.
 *  - **Mode tracé** (pas de `snap`) : le marqueur suit exactement le curseur,
 *    jamais atténué, puisque chaque position est une cible de clic valide.
 *
 * Les performances suivent le schéma établi du survol du graphique
 * (AnalysisFlyoverContext) : `mousemove` ne fait que programmer un
 * `requestAnimationFrame`, et les écritures sont sautées quand le marqueur a
 * bougé de moins de {@link MIN_MOVE_M} depuis la dernière mise à jour.
 */

/** Sauter setData quand le marqueur a bougé de moins que ceci depuis la dernière écriture. */
const MIN_MOVE_M = 8;

export interface UseRouteHoverPreviewArgs {
  map: MapboxMap | null;
  armed: boolean;
  /** Couleur de remplissage du marqueur (couleur du tracé). À défaut, celle de la couche. */
  color?: string;
  /**
   * Sommets du tracé auxquels s'accrocher. Omis / null pour le mode suivi libre
   * (tracé) ; fournis pour le mode accroché au tracé (découpe).
   */
  snapRoutePoints?: RouteSnapPoint[] | null;
}

export function useRouteHoverPreview({
  map,
  armed,
  color,
  snapRoutePoints,
}: UseRouteHoverPreviewArgs): void {
  const lastMarkerRef = useRef<{ lon: number; lat: number; dimmed: boolean } | null>(null);
  const pendingEventRef = useRef<MapMouseEvent | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!armed || !map) {
      lastMarkerRef.current = null;
      return;
    }

    const scheduleSync = (event: MapMouseEvent) => {
      pendingEventRef.current = event;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const pending = pendingEventRef.current;
        pendingEventRef.current = null;
        if (!pending) return;
        applyPreview(pending);
      });
    };

    const applyPreview = (event: MapMouseEvent) => {
      let next: { lon: number; lat: number; dimmed: boolean };

      if (snapRoutePoints && snapRoutePoints.length >= 2) {
        const projection = findSplitProjectionForMapHover(
          map,
          snapRoutePoints,
          event.point.x,
          event.point.y,
        );
        if (!projection) return;
        next = {
          lon: projection.snapped.lon,
          lat: projection.snapped.lat,
          dimmed: !projection.withinTolerance,
        };
      } else {
        next = {
          lon: event.lngLat.lng,
          lat: event.lngLat.lat,
          dimmed: false,
        };
      }

      const previous = lastMarkerRef.current;
      if (
        previous
        && previous.dimmed === next.dimmed
        && haversineRouteDistanceM(previous, next) <= MIN_MOVE_M
      ) {
        return;
      }

      lastMarkerRef.current = next;
      setRouteHoverPreview(map, { ...next, color });
    };

    const handleMouseLeave = () => {
      pendingEventRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastMarkerRef.current = null;
      clearRouteHoverPreview(map);
    };

    map.on('mousemove', scheduleSync);
    map.on('mouseleave', handleMouseLeave);
    // Effacer au premier mouvement pour qu'un marqueur périmé d'un armement
    // précédent ne traîne pas avant que le curseur ne bouge vraiment.
    clearRouteHoverPreview(map);

    return () => {
      map.off('mousemove', scheduleSync);
      map.off('mouseleave', handleMouseLeave);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingEventRef.current = null;
      lastMarkerRef.current = null;
      clearRouteHoverPreview(map);
    };
  }, [armed, map, color, snapRoutePoints]);
}
