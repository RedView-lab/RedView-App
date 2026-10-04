import type {
  Itinerary,
  TimelineAddItemOptions,
  TimelineAddItemKind,
  TimelineItem,
} from '../../types';
import { translateAppText } from '@/shared/i18n';
import {
  getRoutingEndpoints,
  getRoutingInputsSignature,
} from '../../hooks/useItineraryBrouterRouting/projectMutations';
import {
  getRoutePointTotalDistanceM,
  narrowRoutePatchToEdit,
} from '../../hooks/useItineraryBrouterRoutingShared';
import {
  cumulativeRouteLengthsM,
  projectPointAlongRoute,
  roundDistanceKm,
} from '@/features/itineraryPanel/lib/routes';

function isRoutableTimelineRow(
  row: TimelineItem | null | undefined,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row
    && (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end')
    && row.lat != null
    && row.lon != null,
  );
}

/**
 * Tracé stocké éditable localement, qu'il vienne de BRouter ou d'un GPX
 * importé : une édition patche le tronçon concerné au lieu de tout recalculer.
 */
export function hasEditableRoute(itinerary: Itinerary): boolean {
  return (itinerary.gpxRoute?.points.length ?? 0) >= 2;
}

/** Position sur le tracé stocké (m) qu'une édition invalide. */
interface EditedRoutePosition {
  atM: number;
  /** Déduite d'un kilométrage projeté (cf. RoutePatchEdit.projected). */
  projected: boolean;
}

/**
 * Ancienne position d'une ligne sur le tracé stocké : départ et arrivée en
 * sont les extrémités ; une étape déplacée garde son kilométrage jusqu'au
 * recalcul, une étape insérée reçoit celui de sa projection.
 */
function editedRowRoutePosition(itinerary: Itinerary, rowId: string): EditedRoutePosition | null {
  const row = itinerary.timeline.find((item) => item.id === rowId);
  const points = itinerary.gpxRoute?.points;
  if (!row || !points || points.length < 2) return null;
  if (row.kind === 'start') return { atM: 0, projected: false };
  if (row.kind === 'end') return { atM: getRoutePointTotalDistanceM(points), projected: false };
  return row.kind === 'waypoint' && row.distanceKm != null && Number.isFinite(row.distanceKm)
    ? { atM: row.distanceKm * 1_000, projected: true }
    : null;
}

/** Restreint le patch à une fenêtre du tracé stocké autour de l'édition (cf. narrowRoutePatchToEdit). */
function narrowPatchAroundEdit(
  itinerary: Itinerary,
  patch: Itinerary['pendingRoutePatch'],
  edited: EditedRoutePosition | null,
): Itinerary['pendingRoutePatch'] {
  const points = itinerary.gpxRoute?.points;
  if (!patch || !edited || !points || points.length < 2) return patch;
  return narrowRoutePatchToEdit(patch, points, {
    fromM: edited.atM,
    toM: edited.atM,
    projected: edited.projected,
  });
}

/**
 * Patch d'une ligne déplacée, ajoutée ou placée : recalcul entre ses voisines,
 * restreint à une fenêtre du tracé stocké autour de l'édition.
 * `editedAtM` : position (m de tracé) de l'édition quand la ligne n'en porte
 * pas (point inséré en tirant le tracé, lieu choisi pour une nouvelle étape).
 */
export function buildPendingRoutePatchForEditedRow(
  itinerary: Itinerary,
  rowId: string,
  editedAtM?: number,
): Itinerary['pendingRoutePatch'] {
  const edited = editedAtM != null && Number.isFinite(editedAtM)
    ? { atM: editedAtM, projected: true }
    : editedRowRoutePosition(itinerary, rowId);
  return narrowPatchAroundEdit(itinerary, buildNeighbourRoutePatch(itinerary.timeline, rowId), edited);
}

/** Patch entre les lignes routables voisines de `rowId`, via la ligne elle-même. */
function buildNeighbourRoutePatch(
  timeline: TimelineItem[],
  rowId: string,
): Itinerary['pendingRoutePatch'] {
  const routableRows = timeline.filter(isRoutableTimelineRow);
  const focusIndex = routableRows.findIndex((row) => row.id === rowId);
  if (focusIndex < 0) return undefined;

  const focus = routableRows[focusIndex];
  if (focus.kind === 'start') {
    const next = routableRows[focusIndex + 1];
    if (!next) return undefined;
    return {
      start: { lat: focus.lat, lon: focus.lon, kind: 'start' },
      end: { lat: next.lat, lon: next.lon, kind: next.kind === 'end' ? 'end' : 'waypoint' },
      via: [],
    };
  }

  if (focus.kind === 'end') {
    const previous = routableRows[focusIndex - 1];
    if (!previous) return undefined;
    return {
      start: { lat: previous.lat, lon: previous.lon, kind: previous.kind === 'start' ? 'start' : 'waypoint' },
      end: { lat: focus.lat, lon: focus.lon, kind: 'end' },
      via: [],
    };
  }

  const previous = routableRows[focusIndex - 1];
  const next = routableRows[focusIndex + 1];
  if (!previous || !next) return undefined;
  return {
    start: { lat: previous.lat, lon: previous.lon, kind: previous.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: next.lat, lon: next.lon, kind: next.kind === 'end' ? 'end' : 'waypoint' },
    via: [{ lat: focus.lat, lon: focus.lon }],
  };
}

/**
 * Patch après le retrait de `removedRow` (`itinerary.timeline` déjà mise à
 * jour, `previousTimeline` celle d'avant) : recalcul entre ses anciennes
 * voisines encore présentes, restreint à une fenêtre autour de sa position.
 * Une étape posée sur le tracé sans le contraindre (`onRoute`) ne change rien.
 */
function buildPendingRoutePatchAfterRemoval(
  itinerary: Itinerary,
  previousTimeline: TimelineItem[],
  removedRow: TimelineItem | null,
): Itinerary['pendingRoutePatch'] {
  if (!isRoutableTimelineRow(removedRow) || removedRow.onRoute) {
    return undefined;
  }
  const { timeline } = itinerary;

  if (removedRow.kind === 'start') {
    const promotedStart = timeline.find((row) => row.kind === 'start');
    return promotedStart ? buildNeighbourRoutePatch(timeline, promotedStart.id) : undefined;
  }

  if (removedRow.kind === 'end') {
    const promotedEnd = timeline.find((row) => row.kind === 'end');
    return promotedEnd ? buildNeighbourRoutePatch(timeline, promotedEnd.id) : undefined;
  }

  // Voisines dans l'ordre d'avant le retrait, parmi les lignes restantes
  // (d'autres lignes liées, un POI par exemple, ont pu partir avec elle).
  const remainingIds = new Set(timeline.filter(isRoutableTimelineRow).map((row) => row.id));
  const rows = previousTimeline.filter(
    (row) => row.id === removedRow.id || (isRoutableTimelineRow(row) && remainingIds.has(row.id)),
  );
  const removedAt = rows.findIndex((row) => row.id === removedRow.id);
  const before = rows[removedAt - 1];
  const after = rows[removedAt + 1];
  if (!isRoutableTimelineRow(before) || !isRoutableTimelineRow(after)) return undefined;

  const patch: Itinerary['pendingRoutePatch'] = {
    start: { lat: before.lat, lon: before.lon, kind: before.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: after.lat, lon: after.lon, kind: after.kind === 'end' ? 'end' : 'waypoint' },
    via: [],
  };
  const edited = removedRow.distanceKm != null && Number.isFinite(removedRow.distanceKm)
    ? { atM: removedRow.distanceKm * 1_000, projected: true }
    : null;
  return narrowPatchAroundEdit(itinerary, patch, edited);
}

/**
 * Lignes retirées (étape, ou POI avec ses étapes liées ; `itinerary.timeline`
 * déjà mise à jour) : une seule étape qui contraignait le tracé → patch local
 * autour d'elle ; sinon aucun patch, le changement des via déclenche au besoin
 * le recalcul complet.
 */
export function setPendingRoutePatchAfterRemoval(
  itinerary: Itinerary,
  previousTimeline: TimelineItem[],
): void {
  const remainingIds = new Set(itinerary.timeline.map((row) => row.id));
  const removed = previousTimeline.filter(
    (row) => !remainingIds.has(row.id) && isRoutableTimelineRow(row) && !row.onRoute,
  );
  const patch = removed.length === 1 && hasEditableRoute(itinerary)
    ? buildPendingRoutePatchAfterRemoval(itinerary, previousTimeline, removed[0]!)
    : undefined;
  if (patch) itinerary.pendingRoutePatch = patch;
  else delete itinerary.pendingRoutePatch;
}

/**
 * Ligne qui vient de recevoir sa position (étape ajoutée, lieu choisi) : pose
 * l'édition de tracé en attente. Sans arrivée, une étape ajoutée en queue
 * prolonge le tracé depuis le dernier point routé (extension, comme le
 * traceur) ; sinon patch local autour d'elle, ou recalcul complet.
 */
export function setPendingRouteEditForPlacedRow(
  itinerary: Itinerary,
  rowId: string,
  editedAtM?: number,
): void {
  const extension = buildOpenRouteExtension(itinerary, rowId);
  if (extension) {
    itinerary.pendingTraceExtension = extension;
    delete itinerary.pendingRoutePatch;
    return;
  }
  delete itinerary.pendingTraceExtension;
  itinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(itinerary, rowId, editedAtM);
}

function buildOpenRouteExtension(
  itinerary: Itinerary,
  rowId: string,
): Itinerary['pendingTraceExtension'] {
  const route = itinerary.gpxRoute;
  if (route?.source !== 'brouter' || route.points.length < 2) return undefined;
  const endRow = itinerary.timeline.find((item) => item.kind === 'end');
  if (endRow?.lat != null && endRow.lon != null) return undefined;
  const { start, end } = getRoutingEndpoints(itinerary);
  const row = itinerary.timeline.find((item) => item.id === rowId);
  if (!start || !end || row?.kind !== 'waypoint' || row.lat !== end.lat || row.lon !== end.lon) {
    return undefined;
  }
  // Le tracé stocké doit être celui des points d'avant l'ajout : il se
  // termine alors exactement au point routé précédent.
  const before = { ...itinerary, timeline: itinerary.timeline.filter((item) => item.id !== rowId) };
  const from = getRoutingEndpoints(before).end;
  if (!from || route.routedInputsKey !== getRoutingInputsSignature(before)) return undefined;
  return { from, to: { lat: end.lat, lon: end.lon } };
}

/**
 * Insert a brand-new `waypoint` row into the timeline at the position that
 * matches where the user grabbed the trace (expressed as a cumulative distance
 * along the route). Unlike {@link insertTimelineItem} — which always appends
 * before the `end` row — this places the row in physical order along the route
 * so the downstream patch (`buildPendingRoutePatchForEditedRow`) reroutes the
 * correct local segment.
 *
 * Returns the new row's id and the grabbed position along the route (or null
 * when the geometry is unusable), so the caller can feed them straight to
 * `buildPendingRoutePatchForEditedRow`.
 *
 * @param routePoints  Active Brouter route points (must be ≥ 2).
 * @param anchorLonLat Geographic coordinate the user grabbed on the trace.
 *                     Projected onto the polyline to derive the insertion
 *                     distance — not stored on the row.
 * @param dropLatLon   Coordinate where the user released the drag. Becomes the
 *                     waypoint's persisted lat/lon (BRouter snaps it to the
 *                     nearest road server-side).
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

  // Walk the timeline in order, finding the index of the first routable row
  // whose distance exceeds the anchor. The new waypoint splices in just before
  // it. `end` (distance = total) naturally acts as a sentinel for an anchor
  // near the tail.
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

  // Clamp so we never insert past the `end` row's natural tail slot.
  const endIndex = timeline.findIndex((row) => row.kind === 'end');
  if (endIndex >= 0) insertIndex = Math.min(insertIndex, endIndex);

  const isDirectOnRoute =
    Math.abs(dropLatLon.lat - anchorLonLat.lat) < 1e-6 &&
    Math.abs(dropLatLon.lon - anchorLonLat.lon) < 1e-6;

  const newRowId = `wp-drag-${Date.now()}`;
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
   * Position along the route (m) when the point was picked on the route
   * itself (analysis chart): used as is instead of projecting the point, which
   * could land on another pass of a loop or an out-and-back.
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

export function buildTimelineAfterRemoval(
  timeline: TimelineItem[],
  rowId: string,
): TimelineItem[] | null {
  const removedIndex = timeline.findIndex((row) => row.id === rowId);
  const removedRow = removedIndex >= 0 ? timeline[removedIndex] : null;
  if (!removedRow) return null;

  if (removedRow.kind === 'start') {
    const remaining = timeline.filter((row) => row.id !== rowId);
    const promotedIndex = remaining.findIndex(isPromotableEndpointRow);
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
    const promotedIndex = findLastPromotableEndpointIndex(remaining);
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

/**
 * « Démarrer ici » / « Finir ici » : pose le départ ou l'arrivée sur `point`
 * (ligne créée si absente) et prépare le recalcul local du tracé stocké.
 */
export function placeRouteEndpoint(
  itinerary: Itinerary,
  endpoint: 'start' | 'end',
  point: { lat: number; lon: number },
  label: string,
): TimelineItem | null {
  let row = itinerary.timeline.find((item) => item.kind === endpoint);
  if (!row) {
    insertTimelineItem(itinerary.timeline, endpoint);
    row = itinerary.timeline.find((item) => item.kind === endpoint);
  }
  if (!row) return null;

  row.label = label;
  row.lat = point.lat;
  row.lon = point.lon;
  row.distanceKm = endpoint === 'start' ? 0 : null;
  delete itinerary.routeAudit;
  delete itinerary.pendingTraceExtension;
  itinerary.prediction = null;

  if (hasEditableRoute(itinerary)) {
    itinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(itinerary, row.id);
  }
  return row;
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
    id: `wp-${Date.now()}`,
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
    id: id ?? `${kind}-${Date.now()}`,
    kind,
    label: translateAppText('Rechercher un lieu'),
    distanceKm: kind === 'start' ? 0 : null,
  };
}

function createTimelineItem(kind: TimelineAddItemKind): TimelineItem | null {
  const now = Date.now();

  switch (kind) {
    case 'step':
      return {
        id: `step-${now}`,
        kind: 'waypoint',
        label: translateAppText('Rechercher un lieu'),
        distanceKm: null,
      };
    case 'waypoint':
      return {
        id: `wp-${now}`,
        kind: 'waypoint',
        label: translateAppText('Nouveau point'),
        distanceKm: null,
      };
    case 'poi':
      return {
        id: `poi-${now}`,
        kind: 'poi',
        label: 'POI',
        distanceKm: null,
      };
    case 'pause':
      return {
        id: `pause-${now}`,
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

function findLastPromotableEndpointIndex(timeline: TimelineItem[]): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (isPromotableEndpointRow(timeline[index])) return index;
  }
  return -1;
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