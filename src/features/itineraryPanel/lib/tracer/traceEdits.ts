import type { Itinerary, TimelineItem } from '../../types';

/**
 * Primitives pures d'édition du tracé, utilisées par l'outil « Tracer ».
 *
 * Chaque helper mute l'itinéraire reçu en place : les appelants travaillent
 * toujours sur un clone (brouillon de projet ou variante fraîchement forké).
 *
 * Ces helpers ne touchent **pas** à `pendingRoutePatch` : ce champ est construit
 * par `buildPendingRoutePatchForEditedRow`, qui vit dans la couche composants.
 * C'est à l'appelant de le poser juste après l'édition.
 */

/** Types de lignes de timeline manipulables comme points de passage sur la carte. */
export type TracePointKind = 'start' | 'end' | 'waypoint';

export type TraceAppendKind = TracePointKind;

export interface TraceAppendPoint {
  lat: number;
  lon: number;
  label: string;
}

/** Types de lignes de timeline déplaçables sur la carte en mode Tracer. */
const MOVABLE_KINDS = new Set<TimelineItem['kind']>(['start', 'end', 'waypoint']);

function resetTraceMetrics(metrics: Itinerary['metrics']): Itinerary['metrics'] {
  if (!metrics) return metrics;
  return {
    ...metrics,
    distanceKm: undefined,
    ascentM: undefined,
    descentM: undefined,
    avgSlopePercent: undefined,
    tarmacPercent: undefined,
    offroadPercent: undefined,
  };
}

/**
 * Décide où atterrit le prochain clic de tracé :
 * `start` tant que le départ n'est pas posé, `end` pour l'arrivée, puis `waypoint`.
 * Retourne `null` si l'itinéraire n'est pas traçable (départ/arrivée manquants).
 */
export function resolveTraceAppendKind(itinerary: Itinerary): TraceAppendKind | null {
  const startRow = itinerary.timeline.find((row) => row.kind === 'start');
  const endRow = itinerary.timeline.find((row) => row.kind === 'end');
  if (!startRow || !endRow) return null;
  if (startRow.lat == null || startRow.lon == null) return 'start';
  if (endRow.lat == null || endRow.lon == null) return 'end';
  return 'waypoint';
}

/**
 * Ajoute un point de tracé à l'itinéraire (muté en place).
 *
 * Reproduit exactement l'ancienne logique de `appendTracePoint` :
 *  - départ / arrivée : simple positionnement du point d'extrémité ;
 *  - au-delà : l'arrivée courante est convertie en `waypoint`, une nouvelle
 *    arrivée est insérée juste après, et une extension BRouter est demandée
 *    entre l'ancienne et la nouvelle arrivée.
 *
 * Retourne le type de point effectivement ajouté, ou `null` si rien n'a pu l'être.
 */
export function applyTraceAppend(
  itinerary: Itinerary,
  point: TraceAppendPoint,
): TraceAppendKind | null {
  const kind = resolveTraceAppendKind(itinerary);
  if (!kind) return null;

  if (kind === 'start') {
    const startRow = itinerary.timeline.find((row) => row.kind === 'start');
    if (!startRow) return null;

    startRow.label = point.label;
    startRow.lat = point.lat;
    startRow.lon = point.lon;
    startRow.distanceKm = 0;
    itinerary.metrics = resetTraceMetrics(itinerary.metrics);
    delete itinerary.routeAudit;
    delete itinerary.pendingTraceExtension;
    delete itinerary.pendingRoutePatch;
    itinerary.prediction = null;
    return 'start';
  }

  if (kind === 'end') {
    const endRow = itinerary.timeline.find((row) => row.kind === 'end');
    if (!endRow) return null;

    endRow.label = point.label;
    endRow.lat = point.lat;
    endRow.lon = point.lon;
    endRow.distanceKm = null;
    itinerary.metrics = resetTraceMetrics(itinerary.metrics);
    delete itinerary.routeAudit;
    delete itinerary.pendingTraceExtension;
    delete itinerary.pendingRoutePatch;
    itinerary.prediction = null;
    return 'end';
  }

  const endIndex = itinerary.timeline.findIndex((row) => row.kind === 'end');
  if (endIndex < 0) return null;
  const endRow = itinerary.timeline[endIndex];
  if (endRow.lat == null || endRow.lon == null) return null;

  const previousEndLat = endRow.lat;
  const previousEndLon = endRow.lon;
  const waypointId = `wp-${Date.now()}-${Math.round(point.lat * 1e5)}-${Math.round(point.lon * 1e5)}`;

  const previousEndWaypoint: TimelineItem = {
    ...endRow,
    id: waypointId,
    kind: 'waypoint',
    distanceKm: endRow.distanceKm,
  };
  const nextEndRow: TimelineItem = {
    ...endRow,
    label: point.label,
    lat: point.lat,
    lon: point.lon,
    distanceKm: null,
  };

  itinerary.timeline.splice(endIndex, 1, previousEndWaypoint, nextEndRow);
  itinerary.timeline = itinerary.timeline.map((row) => {
    if (row.kind === 'start') {
      return row.distanceKm === 0 ? row : { ...row, distanceKm: 0 };
    }
    if (row.kind === 'end') {
      return row.distanceKm == null ? row : { ...row, distanceKm: null };
    }
    return row;
  });

  if (itinerary.gpxRoute?.source === 'brouter' && (itinerary.gpxRoute.points.length ?? 0) >= 2) {
    itinerary.pendingTraceExtension = {
      from: { lat: previousEndLat, lon: previousEndLon },
      to: { lat: point.lat, lon: point.lon },
    };
    delete itinerary.pendingRoutePatch;
  } else {
    delete itinerary.pendingTraceExtension;
    delete itinerary.pendingRoutePatch;
  }

  itinerary.metrics = resetTraceMetrics(itinerary.metrics);
  delete itinerary.routeAudit;
  itinerary.prediction = null;
  return 'waypoint';
}

/**
 * Déplace un point de passage (départ, arrivée ou waypoint) vers une nouvelle
 * position (muté en place). Les distances le long du tracé sont volontairement
 * laissées telles quelles : elles sont recalculées par le recalcul BRouter que
 * l'appelant déclenche via `pendingRoutePatch`.
 *
 * Retourne `false` si la ligne est introuvable, non déplaçable, ou inchangée.
 */
export function moveTracePointInItinerary(
  itinerary: Itinerary,
  rowId: string,
  lon: number,
  lat: number,
): boolean {
  const row = itinerary.timeline.find((item) => item.id === rowId);
  if (!row || !MOVABLE_KINDS.has(row.kind)) return false;
  if (row.lon === lon && row.lat === lat) return false;

  row.lon = lon;
  row.lat = lat;

  delete itinerary.routeAudit;
  delete itinerary.pendingTraceExtension;
  itinerary.prediction = null;
  return true;
}
