import { translateAppText, readDocumentAppLocale } from '@/shared/i18n';
import { cumulativeRouteLengthsM, projectPointAlongRoute, type RouteDistancePoint } from '../../lib/routes';
import {
  buildScheduledTimelineState,
  formatLegDuration,
  parseStartReference,
} from '../../sections/timeline/TimelineTimelineView/utils';
import type { ScheduledTimelineState, StartReference } from '../../sections/timeline/TimelineTimelineView/types';
import type { Itinerary } from '../../types';
import type { CheckpointData } from './types';

/** Filtres de la barre du haut appliqués aux pauses et waypoints. */
export interface CheckpointVisibility {
  pausesEnabled: boolean;
  waypointsEnabled: boolean;
  favorisEnabled: boolean;
}

function getRoutePointDistances(points: Array<{ lat: number; lon: number; distanceM?: number }>): number[] {
  if (points.length === 0) return [];
  const hasEmbedded = points.every(
    (p) => typeof p.distanceM === 'number' && Number.isFinite(p.distanceM),
  );
  if (hasEmbedded) {
    return points.map((p) => p.distanceM as number);
  }
  return cumulativeRouteLengthsM(points);
}

function interpolateRoutePointAtDistanceM(
  routePoints: RouteDistancePoint[],
  distancesM: number[],
  targetDistanceM: number,
): { lat: number; lon: number } | null {
  if (routePoints.length === 0 || distancesM.length === 0) return null;
  if (routePoints.length === 1) return { lat: routePoints[0].lat, lon: routePoints[0].lon };

  const totalM = distancesM[distancesM.length - 1] ?? 0;
  const clampedM = Math.max(0, Math.min(totalM, targetDistanceM));

  if (clampedM <= (distancesM[0] ?? 0)) {
    return { lat: routePoints[0].lat, lon: routePoints[0].lon };
  }
  if (clampedM >= totalM) {
    const last = routePoints[routePoints.length - 1];
    return { lat: last.lat, lon: last.lon };
  }

  let lo = 0;
  let hi = routePoints.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((distancesM[mid] ?? 0) <= clampedM) lo = mid;
    else hi = mid;
  }

  const segStartM = distancesM[lo] ?? 0;
  const segEndM = distancesM[hi] ?? segStartM;
  const segSpanM = segEndM - segStartM;
  const t = segSpanM > 0 ? (clampedM - segStartM) / segSpanM : 0;

  const startPt = routePoints[lo];
  const endPt = routePoints[hi];
  return {
    lat: startPt.lat + (endPt.lat - startPt.lat) * t,
    lon: startPt.lon + (endPt.lon - startPt.lon) * t,
  };
}

/**
 * Heures affichées par la popup départ / arrivée. L'arrivée n'est estimée
 * qu'avec une prédiction : sans elle, la durée serait une pure supposition.
 */
function resolveEndpointTimeLabels(
  reference: StartReference,
  schedule: ScheduledTimelineState | null,
  prediction: { points: Array<{ elapsed_time_s: number }> } | null | undefined,
): { start: string | null; end: string | null; total: string | null } {
  const start = reference.reference ? formatCheckpointClock(reference.reference, reference.hasRealDate) : null;
  const points = prediction?.points ?? [];
  const last = points[points.length - 1];
  if (!schedule || !last) return { start, end: null, total: null };

  const stopSeconds = schedule.stopAnchors.reduce((sum, anchor) => sum + anchor.durationMin * 60, 0);
  const totalSeconds = last.elapsed_time_s + stopSeconds;
  const end = reference.reference
    ? formatCheckpointClock(new Date(reference.reference.getTime() + totalSeconds * 1000), reference.hasRealDate)
    : null;
  return { start, end, total: formatLegDuration(totalSeconds) };
}

function formatCheckpointClock(date: Date, withDay: boolean): string {
  const locale = readDocumentAppLocale() === 'en' ? 'en-GB' : 'fr-FR';
  return date.toLocaleString(
    locale,
    withDay
      ? { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' },
  );
}

function hasPlacedCoord<T extends { lat?: number | null; lon?: number | null }>(
  row: T | undefined,
): row is T & { lat: number; lon: number } {
  return row != null && row.lat != null && row.lon != null;
}

/**
 * Checkpoints affichés pour un itinéraire : départ, arrivée, pauses (posées
 * et d'intervalle) et waypoints, avec la signature qui déclenche la mise à
 * jour du marqueur quand elle change.
 */
export function collectItineraryCheckpoints(
  itinerary: Itinerary,
  { pausesEnabled, waypointsEnabled, favorisEnabled }: CheckpointVisibility,
): CheckpointData[] {
  const checkpoints: CheckpointData[] = [];
  const routePoints: RouteDistancePoint[] = itinerary.gpxRoute?.points ?? [];
  const distancesM = getRoutePointDistances(routePoints);

  // Planning pauses incluses, calculé une seule fois : heures des popups
  // départ / arrivée et pauses d'intervalle.
  const reference = parseStartReference(itinerary.rhythm);
  const hasPrediction = Boolean(itinerary.prediction && itinerary.prediction.points.length >= 2);
  const schedule = hasPrediction
    ? buildScheduledTimelineState(itinerary.timeline, itinerary.prediction, reference, itinerary.rhythm)
    : null;
  const endpointTimes = resolveEndpointTimeLabels(reference, schedule, itinerary.prediction);
  // Édition en attente de routage : le tracé stocké est l'ancien. Les points
  // restent là où l'utilisateur les a posés au lieu de revenir sur lui.
  const routeEditPending = Boolean(itinerary.pendingRoutePatch || itinerary.pendingTraceExtension);
  // Même règle que buildTimelineAfterRemoval : une étape placée prend la place
  // du départ / de l'arrivée supprimé(e).
  const endpointRemovable = itinerary.timeline.some((row) => row.kind === 'waypoint' && hasPlacedCoord(row));

  // 1. Start checkpoint
  let startCoord: [number, number] | null = null;
  let startLabel = '';
  const startRow = itinerary.timeline.find((row) => row.kind === 'start');
  if (routeEditPending && hasPlacedCoord(startRow)) {
    startCoord = [startRow.lon, startRow.lat];
    startLabel = startRow.label ?? '';
  } else if (routePoints.length > 0) {
    const firstPt = routePoints[0];
    startCoord = [firstPt.lon, firstPt.lat];
    startLabel = startRow?.label ?? '';
  } else if (hasPlacedCoord(startRow)) {
    startCoord = [startRow.lon, startRow.lat];
    startLabel = startRow.label ?? '';
  }

  if (startCoord) {
    const key = `${itinerary.id}:start`;
    const signature = `${key}:${startCoord[0].toFixed(6)},${startCoord[1].toFixed(6)}:${startLabel}:${endpointTimes.start ?? ''}:${endpointRemovable ? '1' : '0'}`;
    checkpoints.push({
      key,
      kind: 'start',
      coord: startCoord,
      label: startLabel,
      itineraryId: itinerary.id,
      signature,
      rowId: startRow?.id,
      distanceKm: 0,
      timeLabel: endpointTimes.start,
      removable: endpointRemovable && Boolean(startRow),
    });
  }

  // 2. End checkpoint
  let endCoord: [number, number] | null = null;
  let endLabel = '';
  const endRow = itinerary.timeline.find((row) => row.kind === 'end');
  // Sans arrivée posée, le tracé s'arrête sur la dernière étape, qui a
  // déjà son marqueur.
  const endIsPlaced = !endRow || hasPlacedCoord(endRow);
  if (routeEditPending && hasPlacedCoord(endRow)) {
    endCoord = [endRow.lon, endRow.lat];
    endLabel = endRow.label ?? '';
  } else if (routePoints.length >= 2 && endIsPlaced) {
    const lastPt = routePoints[routePoints.length - 1];
    endCoord = [lastPt.lon, lastPt.lat];
    endLabel = endRow?.label ?? '';
  } else if (hasPlacedCoord(endRow)) {
    endCoord = [endRow.lon, endRow.lat];
    endLabel = endRow.label ?? '';
  }

  if (endCoord) {
    const key = `${itinerary.id}:end`;
    const routeTotalKm = distancesM.length >= 2 ? (distancesM[distancesM.length - 1] ?? 0) / 1000 : null;
    const endDistanceKm = endRow?.distanceKm ?? routeTotalKm;
    const signature = `${key}:${endCoord[0].toFixed(6)},${endCoord[1].toFixed(6)}:${endLabel}:${endDistanceKm ?? ''}:${endpointTimes.end ?? ''}:${endpointTimes.total ?? ''}:${endpointRemovable ? '1' : '0'}`;
    checkpoints.push({
      key,
      kind: 'end',
      coord: endCoord,
      label: endLabel,
      itineraryId: itinerary.id,
      signature,
      rowId: endRow?.id,
      distanceKm: endDistanceKm,
      timeLabel: endpointTimes.end,
      durationLabel: endpointTimes.total,
      removable: endpointRemovable && Boolean(endRow),
    });
  }

  // 3. Pauses (if enabled in top bar, or if favorite)
  const pauseRows = itinerary.timeline.filter(
    (row) =>
      row.kind === 'pause' &&
      row.visible !== false &&
      ((pausesEnabled && (favorisEnabled || !row.favorite)) ||
        (favorisEnabled && row.favorite === true)),
  );
  for (const row of pauseRows) {
    let coord: [number, number] | null = null;
    if (row.lat != null && row.lon != null) {
      coord = [row.lon, row.lat];
    } else if (routePoints.length >= 2 && Number.isFinite(row.distanceKm)) {
      const targetM = (row.distanceKm as number) * 1000;
      const pt = interpolateRoutePointAtDistanceM(routePoints, distancesM, targetM);
      if (pt) coord = [pt.lon, pt.lat];
    }

    if (coord) {
      const key = `${itinerary.id}:pause:${row.id}`;
      const label = row.label || translateAppText('Pause');
      const signature = `${key}:${coord[0].toFixed(6)},${coord[1].toFixed(6)}:${label}:${row.distanceKm ?? ''}:${row.durationMin ?? 0}:${row.favorite ? '1' : '0'}`;
      checkpoints.push({
        key,
        kind: 'pause',
        coord,
        label,
        itineraryId: itinerary.id,
        signature,
        pauseId: row.id,
        durationMin: row.durationMin ?? 15,
        distanceKm: row.distanceKm ?? null,
        favorite: row.favorite === true,
      });
    }
  }

  // 3b. Auto-generated interval pauses
  if (pausesEnabled && itinerary.rhythm?.pauseEveryIntervalEnabled && schedule) {
    for (const autoPause of schedule.autoPauses) {
      if (autoPause.visible === false) continue;
      if (autoPause.source !== 'interval') continue;
      let coord: [number, number] | null = null;
      if (routePoints.length >= 2 && Number.isFinite(autoPause.distanceKm)) {
        const targetM = autoPause.distanceKm * 1000;
        const pt = interpolateRoutePointAtDistanceM(routePoints, distancesM, targetM);
        if (pt) coord = [pt.lon, pt.lat];
      }
      if (coord) {
        const key = `${itinerary.id}:pause:${autoPause.id}`;
        const label = autoPause.label || translateAppText('Pause');
        const signature = `${key}:${coord[0].toFixed(6)},${coord[1].toFixed(6)}:${label}:${autoPause.distanceKm}:${autoPause.durationMin ?? 0}`;
        checkpoints.push({
          key,
          kind: 'pause',
          coord,
          label,
          itineraryId: itinerary.id,
          signature,
          pauseId: autoPause.id,
          durationMin: autoPause.durationMin ?? 15,
          distanceKm: autoPause.distanceKm,
        });
      }
    }
  }

  // 4. Waypoints (if enabled in top bar, or if favorite)
  const waypointRows = itinerary.timeline.filter(
    (row) =>
      row.kind === 'waypoint' &&
      row.visible !== false &&
      ((waypointsEnabled && (favorisEnabled || !row.favorite)) ||
        (favorisEnabled && row.favorite === true)),
  );
  for (const row of waypointRows) {
    let coord: [number, number] | null = null;
    if (routeEditPending && hasPlacedCoord(row)) {
      coord = [row.lon, row.lat];
    } else if (routePoints.length >= 2) {
      if (row.lat != null && row.lon != null) {
        const snapped = projectPointAlongRoute(
          { lat: row.lat, lon: row.lon },
          routePoints,
          distancesM,
        );
        if (snapped) {
          coord = [snapped.lon, snapped.lat];
        }
      }
      if (!coord && Number.isFinite(row.distanceKm)) {
        const targetM = (row.distanceKm as number) * 1000;
        const pt = interpolateRoutePointAtDistanceM(routePoints, distancesM, targetM);
        if (pt) coord = [pt.lon, pt.lat];
      }
    }
    if (!coord && row.lat != null && row.lon != null) {
      coord = [row.lon, row.lat];
    }

    if (coord) {
      const key = `${itinerary.id}:waypoint:${row.id}`;
      const label = row.label || translateAppText('Waypoint');
      const signature = `${key}:${coord[0].toFixed(6)},${coord[1].toFixed(6)}:${label}:${row.distanceKm ?? ''}:${row.favorite ? '1' : '0'}`;
      checkpoints.push({
        key,
        kind: 'waypoint',
        coord,
        label,
        itineraryId: itinerary.id,
        signature,
        waypointId: row.id,
        rowId: row.id,
        distanceKm: row.distanceKm ?? null,
        favorite: row.favorite === true,
      });
    }
  }

  return checkpoints;
}
