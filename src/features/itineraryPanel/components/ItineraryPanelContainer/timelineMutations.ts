import type {
  TimelineAddItemOptions,
  TimelineAddItemKind,
  TimelineItem,
} from '../../types';
import { translateAppText } from '@/shared/i18n';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
  roundDistanceKm,
} from '@/features/itineraryPanel/lib/routes';
import { createDocumentId } from '../../lib/project/ids';
import { isRoutableTimelineRow } from './timelineRoutePatch';

/**
 * Insère une toute nouvelle ligne `waypoint` dans la timeline à la position
 * correspondant à l'endroit où l'utilisateur a saisi le tracé (exprimé en
 * distance cumulée le long de la route). Contrairement à
 * {@link insertTimelineItem} — qui ajoute toujours avant la ligne `end` — ceci
 * place la ligne dans l'ordre physique le long du tracé pour que le patch en aval
 * (`buildPendingRoutePatchForEditedRow`) reroute le bon segment local.
 *
 * Renvoie l'id de la nouvelle ligne et la position saisie le long du tracé (ou
 * null quand la géométrie est inutilisable), pour que l'appelant les passe
 * directement à `buildPendingRoutePatchForEditedRow`.
 *
 * @param routePoints  Points du tracé BRouter actif (au moins 2).
 * @param anchorLonLat Coordonnée géographique que l'utilisateur a saisie sur le
 *                     tracé. Projetée sur la polyligne pour en déduire la
 *                     distance d'insertion — pas stockée sur la ligne.
 * @param dropLatLon   Coordonnée où l'utilisateur a relâché le glisser. Devient
 *                     le lat/lon persisté de l'étape (BRouter l'accroche à la
 *                     route la plus proche côté serveur).
 */
export function insertWaypointAtRoutePosition(
  timeline: TimelineItem[],
  routePoints: Array<{ lat: number; lon: number }>,
  anchorLonLat: { lat: number; lon: number },
  dropLatLon: { lat: number; lon: number },
): { newRowId: string; isDirectOnRoute: boolean; anchorDistanceM: number } | null {
  if (routePoints.length < 2) return null;

  const cumulative = cumulativeRouteLengthsM(routePoints);
  const anchor = projectPointAlongRoute(anchorLonLat, routePoints, cumulative);
  if (!anchor) return null;

  // Parcourir la timeline dans l'ordre pour trouver l'indice de la première
  // ligne routable dont la distance dépasse l'ancre. La nouvelle étape s'insère
  // juste avant. `end` (distance = total) sert naturellement de sentinelle pour
  // une ancre proche de la fin.
  let insertIndex = timeline.length;
  for (let index = 0; index < timeline.length; index += 1) {
    const row = timeline[index];
    if (!isRoutableTimelineRow(row)) continue;
    const rowDistanceM = projectPointAlongRoute(
      { lat: row.lat, lon: row.lon },
      routePoints,
      cumulative,
    )?.distanceM;
    if (rowDistanceM != null && rowDistanceM > anchor.distanceM) {
      insertIndex = index;
      break;
    }
  }

  // Borner pour ne jamais insérer après l'emplacement naturel de fin de la ligne `end`.
  const endIndex = timeline.findIndex((row) => row.kind === 'end');
  if (endIndex >= 0) insertIndex = Math.min(insertIndex, endIndex);

  const isDirectOnRoute =
    Math.abs(dropLatLon.lat - anchorLonLat.lat) < 1e-6 &&
    Math.abs(dropLatLon.lon - anchorLonLat.lon) < 1e-6;

  const newRowId = createDocumentId('wp-drag');
  const newRow: TimelineItem = {
    id: newRowId,
    kind: 'waypoint',
    label: translateAppText('Nouveau point'),
    distanceKm: isDirectOnRoute ? roundDistanceKm(anchor.distanceM) : null,
    lat: dropLatLon.lat,
    lon: dropLatLon.lon,
    onRoute: isDirectOnRoute || undefined,
  };
  timeline.splice(insertIndex, 0, newRow);
  return { newRowId, isDirectOnRoute, anchorDistanceM: anchor.distanceM };
}

export interface InsertWaypointOptions {
  id?: string;
  label?: string;
  osmId?: number;
  poiCategory?: TimelineItem['poiCategory'];
  /**
   * Position le long du tracé (m) quand le point a été choisi sur le tracé
   * lui-même (graphique d'analyse) : utilisée telle quelle au lieu de projeter le
   * point, qui pourrait tomber sur un autre passage d'une boucle ou d'un aller-retour.
   */
  routeDistanceM?: number;
}

export interface InsertWaypointResult {
  newRow: TimelineItem;
  isDirectOnRoute: boolean;
  insertIndex: number;
}

/**
 * Insère un point de passage dans la timeline au bon kilométrage projeté sur l'itinéraire.
 * Maintient l'ordre chronologique/croissant des kilomètres pour que le routage BRouter
 * et la feuille de route restent parfaitement cohérents sans aller-retours.
 */
export function insertWaypointIntoTimeline(
  timeline: TimelineItem[],
  point: { lat: number; lon: number },
  routePoints?: Array<{ lat: number; lon: number }> | null,
  options?: InsertWaypointOptions,
): InsertWaypointResult {
  const newRowId =
    options?.id ??
    `map-waypoint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const existingIndex = timeline.findIndex(
    (row) => row.id === newRowId || (options?.osmId != null && row.osmId === options.osmId),
  );
  if (existingIndex >= 0) {
    const existingRow = timeline[existingIndex]!;
    existingRow.kind = 'waypoint';
    if (options?.label) existingRow.label = options.label;
    if (options?.poiCategory) existingRow.poiCategory = options.poiCategory;
    if (options?.osmId != null) existingRow.osmId = options.osmId;
    existingRow.visible = true;
    return {
      newRow: existingRow,
      isDirectOnRoute: true,
      insertIndex: existingIndex,
    };
  }

  const hasRoute = Boolean(routePoints && routePoints.length >= 2);
  const cumulative = hasRoute ? cumulativeRouteLengthsM(routePoints!) : null;
  const routeDistanceM = options?.routeDistanceM;
  const knownRouteDistanceM = hasRoute && routeDistanceM != null && Number.isFinite(routeDistanceM)
    ? routeDistanceM
    : null;
  const anchor = hasRoute && cumulative && knownRouteDistanceM == null
    ? projectPointAlongRoute(point, routePoints!, cumulative)
    : null;

  const distanceKm = knownRouteDistanceM != null
    ? roundDistanceKm(knownRouteDistanceM)
    : anchor ? roundDistanceKm(anchor.distanceM) : null;
  const isDirectOnRoute = knownRouteDistanceM != null || (anchor
    ? Math.abs(point.lat - anchor.lat) < 0.0003 && Math.abs(point.lon - anchor.lon) < 0.0003
    : false);

  const endIndex = timeline.findIndex((row) => row.kind === 'end');
  const searchLimit = endIndex >= 0 ? endIndex : timeline.length;
  let insertIndex = searchLimit;
  // Sans arrivée posée, une étape hors du tracé le prolonge : elle va en
  // queue, pas au kilomètre où elle se projette sur le tracé actuel.
  const endRow = endIndex >= 0 ? timeline[endIndex] : null;
  const extendsOpenRoute = !isDirectOnRoute && (endRow?.lat == null || endRow?.lon == null);

  if (distanceKm != null && hasRoute && cumulative && !extendsOpenRoute) {
    for (let index = 0; index < searchLimit; index += 1) {
      const row = timeline[index];
      if (row.kind === 'start') continue;

      let rowDist = row.distanceKm;
      if (rowDist == null && row.lat != null && row.lon != null) {
        const rowProj = projectPointAlongRoute(
          { lat: row.lat, lon: row.lon },
          routePoints!,
          cumulative,
        );
        if (rowProj) rowDist = roundDistanceKm(rowProj.distanceM);
      }

      if (rowDist != null && rowDist > distanceKm) {
        insertIndex = index;
        break;
      }
    }
  }

  const newRow: TimelineItem = {
    id: newRowId,
    kind: 'waypoint',
    label: options?.label ?? translateAppText('Point de passage'),
    distanceKm: extendsOpenRoute ? null : distanceKm,
    lat: point.lat,
    lon: point.lon,
    osmId: options?.osmId,
    poiCategory: options?.poiCategory,
    onRoute: isDirectOnRoute || undefined,
    visible: true,
  };

  timeline.splice(insertIndex, 0, newRow);

  return { newRow, isDirectOnRoute, insertIndex };
}

/**
 * Timeline sans la ligne `rowId`. Un départ / une arrivée supprimé(e) est
 * remplacé(e) par l'étape placée la plus proche du début / de la fin du
 * tracé (`routePoints`) — pas par l'ordre de la timeline, qui ne suit pas
 * forcément le tracé : une étape plus loin restait sinon après la nouvelle
 * arrivée, affichée sur sa fin. Sans tracé, l'ordre de la timeline.
 */
export function buildTimelineAfterRemoval(
  timeline: TimelineItem[],
  rowId: string,
  routePoints?: ReadonlyArray<{ lat: number; lon: number }>,
): TimelineItem[] | null {
  const removedIndex = timeline.findIndex((row) => row.id === rowId);
  const removedRow = removedIndex >= 0 ? timeline[removedIndex] : null;
  if (!removedRow) return null;

  if (removedRow.kind === 'start') {
    const remaining = timeline.filter((row) => row.id !== rowId);
    const promotedIndex = findPromotableEndpointIndex(remaining, 'start', routePoints);
    if (promotedIndex < 0) return null;

    const promotedRow = remaining[promotedIndex];
    remaining.splice(promotedIndex, 1);
    return [
      {
        ...promotedRow,
        kind: 'start',
        distanceKm: 0,
      },
      ...remaining,
    ];
  }

  if (removedRow.kind === 'end') {
    const remaining = timeline.filter((row) => row.id !== rowId);
    const promotedIndex = findPromotableEndpointIndex(remaining, 'end', routePoints);
    if (promotedIndex < 0) return null;

    const promotedRow = remaining[promotedIndex];
    remaining.splice(promotedIndex, 1);
    return [
      ...remaining,
      {
        ...promotedRow,
        kind: 'end',
        distanceKm: null,
      },
    ];
  }

  return timeline.filter((row) => row.id !== rowId);
}

export function insertTimelineItem(
  timeline: TimelineItem[],
  kind: TimelineAddItemKind,
  options?: TimelineAddItemOptions,
): TimelineItem | null {
  if (kind === 'start') {
    insertEndpointBeforeCurrent(timeline, 'start');
    return null;
  }

  if (kind === 'end') {
    insertEndpointBeforeCurrent(timeline, 'end');
    return null;
  }

  const nextItem = createTimelineItem(kind);
  if (!nextItem) return null;

  if (nextItem.kind === 'pause') {
    nextItem.distanceKm = resolveInitialPauseDistanceKm(timeline, options);
    timeline.splice(resolvePauseInsertIndex(timeline, nextItem.distanceKm), 0, nextItem);
    return nextItem;
  }

  const endIndex = timeline.findIndex((item) => item.kind === 'end');
  const insertAt = endIndex >= 0 ? endIndex : timeline.length;
  timeline.splice(insertAt, 0, nextItem);
  return nextItem;
}

export function moveTimelinePauseItem(
  timeline: TimelineItem[],
  rowId: string,
  distanceKm: number,
): boolean {
  const rowIndex = timeline.findIndex((item) => item.id === rowId && item.kind === 'pause');
  if (rowIndex < 0) return false;

  const [pause] = timeline.splice(rowIndex, 1);
  if (!pause || pause.kind !== 'pause') return false;

  pause.distanceKm = normalizePauseDistanceKm(distanceKm);
  timeline.splice(resolvePauseInsertIndex(timeline, pause.distanceKm), 0, pause);
  return true;
}

function insertEndpointBeforeCurrent(
  timeline: TimelineItem[],
  endpointKind: 'start' | 'end',
): void {
  const currentIndex = timeline.findIndex((item) => item.kind === endpointKind);
  const nextEndpoint = createBlankEndpoint(
    endpointKind,
    currentIndex >= 0 ? timeline[currentIndex].id : undefined,
  );

  if (currentIndex < 0) {
    if (endpointKind === 'start') timeline.unshift(nextEndpoint);
    else timeline.push(nextEndpoint);
    return;
  }

  const currentEndpoint = timeline[currentIndex];
  const promotedWaypoint = {
    ...currentEndpoint,
    id: createDocumentId('wp'),
    kind: 'waypoint' as const,
  };

  if (endpointKind === 'start') {
    timeline.splice(currentIndex, 1, nextEndpoint, promotedWaypoint);
    return;
  }

  timeline.splice(currentIndex, 1, promotedWaypoint, nextEndpoint);
}

function createBlankEndpoint(
  kind: 'start' | 'end',
  id?: string,
): TimelineItem {
  return {
    id: id ?? createDocumentId(kind),
    kind,
    label: translateAppText('Rechercher un lieu'),
    distanceKm: kind === 'start' ? 0 : null,
  };
}

function createTimelineItem(kind: TimelineAddItemKind): TimelineItem | null {
  switch (kind) {
    case 'step':
      return {
        id: createDocumentId('step'),
        kind: 'waypoint',
        label: translateAppText('Rechercher un lieu'),
        distanceKm: null,
      };
    case 'waypoint':
      return {
        id: createDocumentId('wp'),
        kind: 'waypoint',
        label: translateAppText('Nouveau point'),
        distanceKm: null,
      };
    case 'poi':
      return {
        id: createDocumentId('poi'),
        kind: 'poi',
        label: 'POI',
        distanceKm: null,
      };
    case 'pause':
      return {
        id: createDocumentId('pause'),
        kind: 'pause',
        label: translateAppText('Pause'),
        distanceKm: null,
        durationMin: 15,
      };
    case 'start':
      return createBlankEndpoint('start');
    case 'end':
      return createBlankEndpoint('end');
    default:
      return null;
  }
}

function isPromotableEndpointRow(
  row: TimelineItem,
): row is TimelineItem & { kind: 'waypoint'; lat: number; lon: number } {
  return row.kind === 'waypoint' && row.lat != null && row.lon != null;
}

/** Étape qui remplace le départ (la plus proche du début) / l'arrivée (la plus proche de la fin). */
function findPromotableEndpointIndex(
  timeline: TimelineItem[],
  endpoint: 'start' | 'end',
  routePoints: ReadonlyArray<{ lat: number; lon: number }> | undefined,
): number {
  const candidates = timeline
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isPromotableEndpointRow(row));
  if (candidates.length === 0) return -1;

  const points = routePoints && routePoints.length >= 2 ? [...routePoints] : null;
  if (!points) {
    return endpoint === 'start' ? candidates[0]!.index : candidates[candidates.length - 1]!.index;
  }

  const cumulative = cumulativeRouteLengthsM(points);
  // Kilométrage du dernier routage d'abord : sans ambiguïté sur une boucle.
  const positionM = (row: TimelineItem & { lat: number; lon: number }) =>
    row.distanceKm != null && Number.isFinite(row.distanceKm)
      ? row.distanceKm * 1_000
      : projectPointAlongRoute({ lat: row.lat, lon: row.lon }, points, cumulative)?.distanceM ?? null;

  let best: { index: number; atM: number } | null = null;
  for (const { row, index } of candidates) {
    const atM = positionM(row as TimelineItem & { lat: number; lon: number });
    if (atM == null) continue;
    // À égalité, l'ordre de la timeline départage (premier / dernier).
    const better = !best
      || (endpoint === 'start' ? atM < best.atM : atM >= best.atM);
    if (better) best = { index, atM };
  }
  if (best) return best.index;
  return endpoint === 'start' ? candidates[0]!.index : candidates[candidates.length - 1]!.index;
}

function resolveSuggestedPauseDistanceKm(timeline: TimelineItem[]): number {
  const distances = timeline
    .map((item) => item.distanceKm)
    .filter((distance): distance is number => Number.isFinite(distance));

  if (distances.length === 0) return 0.25;

  const maxDistanceKm = Math.max(0, ...distances);
  if (maxDistanceKm <= 0.25) return 0.25;

  let candidateKm = Math.max(0.25, maxDistanceKm * 0.5);
  const occupied = new Set(distances.map((distance) => distance.toFixed(2)));
  while (occupied.has(candidateKm.toFixed(2)) && candidateKm < maxDistanceKm) {
    candidateKm = Math.min(maxDistanceKm, candidateKm + 0.25);
  }

  return Number(candidateKm.toFixed(2));
}

function resolveInitialPauseDistanceKm(
  timeline: TimelineItem[],
  options?: TimelineAddItemOptions,
): number {
  if (Number.isFinite(options?.distanceKm)) {
    return normalizePauseDistanceKm(options?.distanceKm as number);
  }
  return resolveSuggestedPauseDistanceKm(timeline);
}

function normalizePauseDistanceKm(distanceKm: number): number {
  return Math.max(0, Number(distanceKm.toFixed(3)));
}

function resolvePauseInsertIndex(timeline: TimelineItem[], distanceKm: number): number {
  const endIndex = timeline.findIndex((item) => item.kind === 'end');
  const searchEnd = endIndex >= 0 ? endIndex : timeline.length;

  for (let index = 0; index < searchEnd; index += 1) {
    const itemDistanceKm = timeline[index]?.distanceKm;
    if (Number.isFinite(itemDistanceKm) && (itemDistanceKm as number) > distanceKm) {
      return index;
    }
  }

  return searchEnd;
}