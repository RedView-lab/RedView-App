/**
 * Éditions du viewer LiDAR sur un itinéraire routé.
 *
 * L'éditeur du viewer travaille à main levée : il relie ses points par des
 * segments droits. Sur un tracé BRouter (un point par nœud de route), déplacer
 * un point, en ajouter un ou prolonger le tracé y dessine donc des lignes
 * droites — stockées telles quelles dans le projet, puis exportées en GPX.
 * Ici, chaque geste est traduit en l'édition équivalente de l'app (tirer le
 * tracé, ajouter une étape, prolonger au traceur, « Démarrer ici »…) : le
 * routage local de l'app produit le tracé, renvoyé au viewer par la
 * synchronisation. Un tracé importé ou dessiné dans le viewer reste à main
 * levée (`raw`).
 */
import { formatGpsCoordinateLabel } from '../../lib/geocoding';
import { haversineRouteDistanceM } from '../../lib/routes';
import { applyTraceAppend } from '../../lib/tracer/traceEdits';
import type { Itinerary } from '../../types';

import {
  buildTimelineAfterRemoval,
  insertWaypointAtRoutePosition,
  insertWaypointIntoTimeline,
} from './timelineMutations';
import {
  buildPendingRoutePatchForEditedRow,
  setPendingRouteEditForPlacedRow,
  setPendingRoutePatchAfterRemoval,
} from './timelineRoutePatch';
import { placeRouteEndpoint } from './routeEndpointPlacement';

type ViewerPoint = { lat: number; lon: number };

/**
 * - `applied` : traduit en édition de l'itinéraire (à enregistrer) ;
 * - `ignored` : geste sans équivalent routé (point posé sur le tracé, viewer
 *   désynchronisé) — le viewer doit être resynchronisé sur le tracé stocké ;
 * - `raw` : tracé non routé ou geste sans ligne droite (inversion, altitudes)
 *   — les points du viewer sont gardés tels quels.
 */
export type LidarViewerRouteEditOutcome = 'applied' | 'ignored' | 'raw';

/** Écart sous lequel un point du viewer est celui du tracé stocké. */
const SAME_POINT_M = 1;
/** Point supprimé dans le viewer assez près d'une étape pour la désigner. */
const ROW_PICK_M = 30;

const samePoint = (a: ViewerPoint, b: ViewerPoint) => haversineRouteDistanceM(a, b) <= SAME_POINT_M;

/** Seul point déplacé (même nombre de points), sinon `null`. */
function movedPointIndex(stored: ReadonlyArray<ViewerPoint>, next: ReadonlyArray<ViewerPoint>): number | null {
  if (stored.length !== next.length) return null;
  let moved: number | null = null;
  for (let index = 0; index < stored.length; index += 1) {
    if (samePoint(stored[index]!, next[index]!)) continue;
    if (moved != null) return null;
    moved = index;
  }
  return moved;
}

/** Indice du point présent dans `longer` seulement (un point de plus), sinon `null`. */
function extraPointIndex(shorter: ReadonlyArray<ViewerPoint>, longer: ReadonlyArray<ViewerPoint>): number | null {
  if (longer.length !== shorter.length + 1) return null;
  let index = 0;
  while (index < shorter.length && samePoint(shorter[index]!, longer[index]!)) index += 1;
  for (let rest = index; rest < shorter.length; rest += 1) {
    if (!samePoint(shorter[rest]!, longer[rest + 1]!)) return null;
  }
  return index;
}

const pointLabel = (point: ViewerPoint) => formatGpsCoordinateLabel(point.lon, point.lat);

/**
 * Applique à `itinerary` (brouillon muté en place) l'édition faite dans le
 * viewer (`next` : ses points après le geste `actionName`).
 */
export function applyLidarViewerRouteEdit(
  itinerary: Itinerary,
  next: ReadonlyArray<ViewerPoint>,
  actionName: string | undefined,
): LidarViewerRouteEditOutcome {
  const route = itinerary.gpxRoute;
  if (route?.source !== 'brouter' || route.points.length < 2) return 'raw';
  const stored = route.points;

  switch (actionName) {
    case 'set_start':
    case 'set_finish': {
      const endpoint = actionName === 'set_start' ? 'start' : 'end';
      const point = endpoint === 'start' ? next[0] : next[next.length - 1];
      if (!point) return 'ignored';
      const at = { lat: point.lat, lon: point.lon };
      return placeRouteEndpoint(itinerary, endpoint, at, pointLabel(at)) ? 'applied' : 'ignored';
    }
    case 'move_point': {
      // Un point du tracé déplacé : comme tirer le tracé dans l'app.
      const moved = movedPointIndex(stored, next);
      if (moved == null) return 'ignored';
      const drop = { lat: next[moved]!.lat, lon: next[moved]!.lon };
      if (moved === 0 || moved === stored.length - 1) {
        return placeRouteEndpoint(itinerary, moved === 0 ? 'start' : 'end', drop, pointLabel(drop)) ? 'applied' : 'ignored';
      }
      const anchor = { lat: stored[moved]!.lat, lon: stored[moved]!.lon, routeIndex: moved };
      const result = insertWaypointAtRoutePosition(itinerary.timeline, stored, anchor, drop);
      if (!result) return 'ignored';
      if (result.isDirectOnRoute) {
        delete itinerary.pendingRoutePatch;
      } else {
        itinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(itinerary, result.newRowId, result.anchorDistanceM);
        itinerary.prediction = null;
      }
      delete itinerary.pendingTraceExtension;
      delete itinerary.routeAudit;
      return 'applied';
    }
    case 'add_waypoint': {
      // « Ajouter une étape » : comme dans le menu contextuel de l'app.
      const index = extraPointIndex(stored, next);
      if (index == null) return 'ignored';
      const at = { lat: next[index]!.lat, lon: next[index]!.lon };
      const result = insertWaypointIntoTimeline(itinerary.timeline, at, stored, { label: pointLabel(at) });
      delete itinerary.routeAudit;
      if (result.isDirectOnRoute) {
        delete itinerary.pendingTraceExtension;
      } else {
        setPendingRouteEditForPlacedRow(itinerary, result.newRow.id);
        itinerary.prediction = null;
      }
      return 'applied';
    }
    case 'append_point': {
      // Clic après la fin : prolongé comme au traceur de l'app.
      if (extraPointIndex(stored, next) !== stored.length) return 'ignored';
      const last = next[next.length - 1]!;
      const at = { lat: last.lat, lon: last.lon, label: pointLabel(last) };
      return applyTraceAppend(itinerary, at) ? 'applied' : 'ignored';
    }
    case 'delete_point': {
      // Seule la suppression d'une étape a un sens sur un tracé routé.
      const index = extraPointIndex(next, stored);
      if (index == null) return 'ignored';
      const removed = stored[index]!;
      const row = itinerary.timeline.find((item) => item.kind === 'waypoint'
        && !item.onRoute
        && item.lat != null
        && item.lon != null
        && haversineRouteDistanceM({ lat: item.lat, lon: item.lon }, removed) <= ROW_PICK_M);
      if (!row) return 'ignored';
      const previousTimeline = itinerary.timeline;
      const nextTimeline = buildTimelineAfterRemoval(previousTimeline, row.id);
      if (!nextTimeline) return 'ignored';
      itinerary.timeline = nextTimeline;
      setPendingRoutePatchAfterRemoval(itinerary, previousTimeline);
      delete itinerary.pendingTraceExtension;
      delete itinerary.routeAudit;
      itinerary.prediction = null;
      return 'applied';
    }
    case 'insert_point':
      // Point posé sur le tracé : il ne change rien au tracé routé.
      return 'ignored';
    default:
      return 'raw';
  }
}
