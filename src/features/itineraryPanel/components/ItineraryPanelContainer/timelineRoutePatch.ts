import type { Itinerary, TimelineItem } from '../../types';
import { getRoutingEndpoints, routeStampMatches } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import { getRoutePointTotalDistanceM, narrowRoutePatchToEdit } from '../../hooks/useItineraryBrouterRoutingShared';
import { cropItineraryRouteAtEndpoint, finishRouteCrop, storedRouteIsCurrent } from './routeCrop';

export function isRoutableTimelineRow(
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

type RoutePatch = NonNullable<Itinerary['pendingRoutePatch']>;

/**
 * Borne de patch sur une ligne voisine de l'édition. Une étape porte son
 * kilométrage sur le tracé stocké : la borne y est retrouvée sans ambiguïté
 * sur une boucle ou un aller-retour (cf. routePatchBoundaryDistanceM).
 */
function startBound(row: TimelineItem & { lat: number; lon: number }): RoutePatch['start'] {
  if (row.kind === 'start') return { lat: row.lat, lon: row.lon, kind: 'start' };
  return { lat: row.lat, lon: row.lon, kind: 'waypoint', ...rowDistanceHint(row) };
}

function endBound(row: TimelineItem & { lat: number; lon: number }): RoutePatch['end'] {
  if (row.kind === 'end') return { lat: row.lat, lon: row.lon, kind: 'end' };
  return { lat: row.lat, lon: row.lon, kind: 'waypoint', ...rowDistanceHint(row) };
}

function rowDistanceHint(row: TimelineItem): { distanceM?: number } {
  return row.distanceKm != null && Number.isFinite(row.distanceKm) ? { distanceM: row.distanceKm * 1_000 } : {};
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
      end: endBound(next),
      via: [],
    };
  }

  if (focus.kind === 'end') {
    const previous = routableRows[focusIndex - 1];
    if (!previous) return undefined;
    return {
      start: startBound(previous),
      end: { lat: focus.lat, lon: focus.lon, kind: 'end' },
      via: [],
    };
  }

  const previous = routableRows[focusIndex - 1];
  const next = routableRows[focusIndex + 1];
  if (!previous || !next) return undefined;
  return {
    start: startBound(previous),
    end: endBound(next),
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
    start: startBound(before),
    end: endBound(after),
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
  const removedEndpoint = removed.length === 1 ? removed[0]!.kind : null;
  if (
    (removedEndpoint === 'start' || removedEndpoint === 'end')
    && cropRouteAtPromotedEndpoint(itinerary, previousTimeline, removedEndpoint)
  ) {
    return;
  }
  const patch = removed.length === 1 && hasEditableRoute(itinerary)
    ? buildPendingRoutePatchAfterRemoval(itinerary, previousTimeline, removed[0]!)
    : undefined;
  if (patch) itinerary.pendingRoutePatch = patch;
  else delete itinerary.pendingRoutePatch;
}

/** Écart toléré entre une étape promue départ / arrivée et le tracé qui y passait (accroche à la route). */
const PROMOTED_ENDPOINT_CROP_TOLERANCE_M = 500;

/**
 * Départ / arrivée supprimé(e) : l'étape promue à sa place est déjà sur le
 * tracé, qui y passait. On le coupe là, sans routage — sinon le drapeau
 * restait à l'ancienne extrémité jusqu'à la réponse de BRouter. Refusé quand
 * le tracé stocké n'était pas celui des lignes d'avant (édition en attente).
 */
function cropRouteAtPromotedEndpoint(
  itinerary: Itinerary,
  previousTimeline: TimelineItem[],
  endpoint: 'start' | 'end',
): boolean {
  const route = itinerary.gpxRoute;
  if (!route || !hasEditableRoute(itinerary)) return false;
  if (!storedRouteIsCurrent({ ...itinerary, timeline: previousTimeline })) return false;
  const promoted = itinerary.timeline.find((row) => row.kind === endpoint);
  if (!isRoutableTimelineRow(promoted)) return false;

  // Kilométrage de l'étape avant sa promotion (l'arrivée n'en porte plus) :
  // coupe au bon passage d'une boucle.
  const previousKm = previousTimeline.find((row) => row.id === promoted.id)?.distanceKm;
  const cut = cropItineraryRouteAtEndpoint(itinerary, endpoint, promoted, {
    pickToleranceM: PROMOTED_ENDPOINT_CROP_TOLERANCE_M,
    routeDistanceM: previousKm != null && Number.isFinite(previousKm) ? previousKm * 1_000 : undefined,
  });
  if (!cut) return false;
  promoted.lat = cut.lat;
  promoted.lon = cut.lon;
  finishRouteCrop(itinerary);
  return true;
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
  if (!from || !routeStampMatches(before, route.routedInputsKey)) return undefined;
  return { from, to: { lat: end.lat, lon: end.lon } };
}
