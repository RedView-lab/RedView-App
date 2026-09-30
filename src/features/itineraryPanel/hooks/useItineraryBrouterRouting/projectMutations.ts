import { analyzeBrouterRoute } from '../../lib/routeAudit/analyzeBrouterRoute';
import { cleanGpxGlitches } from '../../lib/routes';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
  type RouteProfilePoint,
} from '../../lib/route-metrics';
import type { BrouterRoute } from '../../lib/brouter';
import type { Itinerary, ItineraryProject } from '../../types';
import { normalizeDiscipline } from '@/shared/lib/discipline';
import {
  applyBrouterSurfaceToRoutePoints,
  appendRoutePoints,
  buildStoredRoutePointsFromBrouter,
  getRoutePointTotalDistanceM,
  mergeSurfaceMetrics,
  projectTimelineLocationDistances,
  recomputeApproxSurfaceMetrics,
  replaceRouteSegment,
  roundRouteDistanceKm,
  routeAuditEqual,
  routePointsEqual,
  toGeometryRoutePoints,
  toStoredRoutePoints,
} from '../useItineraryBrouterRoutingShared';

/**
 * Entrées « géométriques » du routage d'un itinéraire : départ, arrivée et via
 * hors-trace, au format attendu par l'effet de routage.
 */
export interface RoutingEndpointsKey {
  startKey: string;
  endKey: string;
  viaKey: string;
}

export function getRoutingEndpointsKey(
  itinerary: Itinerary | null | undefined,
): RoutingEndpointsKey {
  if (!itinerary) return { startKey: '', endKey: '', viaKey: '' };
  const start = itinerary.timeline.find((item) => item.kind === 'start');
  const end = itinerary.timeline.find((item) => item.kind === 'end');
  return {
    startKey: start && start.lat != null && start.lon != null ? `${start.lon},${start.lat}` : '',
    endKey: end && end.lat != null && end.lon != null ? `${end.lon},${end.lat}` : '',
    viaKey: itinerary.timeline
      .filter(
        (item) =>
          item.kind === 'waypoint' &&
          item.lat != null &&
          item.lon != null &&
          !item.onRoute,
      )
      .map((item) => `${item.lon},${item.lat}`)
      .join('|'),
  };
}

/**
 * Signature de *toutes* les entrées qui déterminent un tracé BRouter (points,
 * profil, priorités, types de routes, mode expert, discipline, zones
 * interdites). Estampillée sur chaque tracé routé (`gpxRoute.routedInputsKey`)
 * et sur chaque requête : un résultat n'est appliqué que si l'itinéraire a
 * toujours ces entrées, et après un undo/redo un tracé dont l'estampille ne
 * correspond plus (figé en plein recalcul) est recalculé.
 */
export function getRoutingInputsSignature(itinerary: Itinerary): string {
  const { startKey, endKey, viaKey } = getRoutingEndpointsKey(itinerary);
  // `applyToAllItineraries` est un choix d'interface, sans effet sur le tracé.
  const roadTypes: Record<string, unknown> = { ...itinerary.roadTypes };
  delete roadTypes.applyToAllItineraries;
  return JSON.stringify([
    startKey,
    endKey,
    viaKey,
    itinerary.profileId ?? '',
    normalizeDiscipline(itinerary.discipline),
    itinerary.priorities ?? null,
    roadTypes,
    itinerary.expertProfile ?? null,
    (itinerary.forbiddenZones ?? []).map((zone) => zone.points),
  ]);
}

/**
 * Identifie la requête BRouter à l'origine d'un résultat : l'itinéraire visé et
 * l'état qu'elle devait résoudre. Un résultat n'est appliqué que si cet état
 * est toujours celui de l'itinéraire (sinon undo / nouvelle édition
 * entre-temps : le résultat est périmé et ignoré).
 */
export interface RouteResultTarget {
  itineraryId: string;
  /** `JSON.stringify` du `pendingRoutePatch` / `pendingTraceExtension` demandé. */
  pendingKey?: string;
  /** `getRoutingInputsSignature` de l'itinéraire au lancement du recalcul complet. */
  inputsSignature?: string;
}

function resolveRouteProfile(
  route: BrouterRoute,
  routeProfileOverride?: RouteProfilePoint[] | null,
): RouteProfilePoint[] | null {
  return routeProfileOverride ?? extractRouteProfileFromBrouter(route);
}

export function applyPendingRoutePatch(
  project: ItineraryProject,
  target: RouteResultTarget,
  route: BrouterRoute,
  routeProfileOverride?: RouteProfilePoint[] | null,
): ItineraryProject {
  const itinerary = project.itineraries.find((item) => item.id === target.itineraryId);
  if (!itinerary || !itinerary.pendingRoutePatch) return project;
  if (JSON.stringify(itinerary.pendingRoutePatch) !== target.pendingKey) return project;

  const basePoints = itinerary.gpxRoute?.points ?? [];
  if (basePoints.length < 2) return project;

  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = resolveRouteProfile(route, routeProfileOverride);
  const patchRoutePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  const surfacedPatchRoutePoints = applyBrouterSurfaceToRoutePoints(route, patchRoutePoints);
  const patchSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const mergedRoutePoints = cleanGpxGlitches(
    replaceRouteSegment(
      basePoints,
      itinerary.pendingRoutePatch,
      surfacedPatchRoutePoints,
    ),
  );
  const elevationMetrics = computeRouteElevationMetrics(mergedRoutePoints);
  const distanceM = getRoutePointTotalDistanceM(mergedRoutePoints);
  const distanceKm = roundRouteDistanceKm(distanceM);
  const nextTimeline = projectTimelineLocationDistances(
    itinerary.timeline,
    mergedRoutePoints,
    distanceKm,
  );
  const surfaceMetrics = recomputeApproxSurfaceMetrics(
    itinerary.metrics,
    basePoints,
    itinerary.pendingRoutePatch,
    patchSurfaceMetrics,
    route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(patchRoutePoints),
  );

  return {
    ...project,
    itineraries: project.itineraries.map((current) =>
      current.id === target.itineraryId
        ? {
            ...current,
            visible: true,
            gpxRoute: {
              name: current.gpxRoute?.name ?? null,
              points: mergedRoutePoints,
              originalPoints: mergedRoutePoints,
              gpxQuality: current.gpxRoute?.gpxQuality ?? 'default',
              gpxQualityPointsPerKm: current.gpxRoute?.gpxQualityPointsPerKm ?? null,
              source: 'brouter',
              routedInputsKey: getRoutingInputsSignature(current),
            },
            metrics: {
              ...current.metrics,
              distanceKm,
              ascentM: elevationMetrics
                ? Math.max(0, Math.round(elevationMetrics.ascentM))
                : undefined,
              descentM: elevationMetrics
                ? Math.max(0, Math.round(elevationMetrics.descentM))
                : undefined,
              avgSlopePercent: elevationMetrics
                ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
                : undefined,
              tarmacPercent: surfaceMetrics?.tarmacPercent,
              offroadPercent: surfaceMetrics?.offroadPercent,
            },
            timeline: nextTimeline,
            routeAudit: undefined,
            pendingTraceExtension: undefined,
            pendingRoutePatch: undefined,
          }
        : current,
    ),
  };
}

export function applyPendingTraceAppend(
  project: ItineraryProject,
  target: RouteResultTarget,
  route: BrouterRoute,
  routeProfileOverride?: RouteProfilePoint[] | null,
): ItineraryProject {
  const itinerary = project.itineraries.find((item) => item.id === target.itineraryId);
  if (!itinerary || !itinerary.pendingTraceExtension) return project;
  if (JSON.stringify(itinerary.pendingTraceExtension) !== target.pendingKey) return project;

  const basePoints = itinerary.gpxRoute?.points ?? [];
  if (basePoints.length < 2) return project;

  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = resolveRouteProfile(route, routeProfileOverride);
  const segmentRoutePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  const surfacedSegmentRoutePoints = applyBrouterSurfaceToRoutePoints(route, segmentRoutePoints);
  const segmentSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const mergedRoutePoints = cleanGpxGlitches(appendRoutePoints(basePoints, surfacedSegmentRoutePoints));
  const elevationMetrics = computeRouteElevationMetrics(mergedRoutePoints);
  const totalDistanceM = getRoutePointTotalDistanceM(mergedRoutePoints);
  const distanceKm = roundRouteDistanceKm(totalDistanceM);
  const surfaceMetrics = mergeSurfaceMetrics(
    itinerary.metrics,
    getRoutePointTotalDistanceM(basePoints),
    segmentSurfaceMetrics,
    route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(surfacedSegmentRoutePoints),
  );
  const nextTimeline = projectTimelineLocationDistances(
    itinerary.timeline,
    mergedRoutePoints,
    distanceKm,
  );

  return {
    ...project,
    itineraries: project.itineraries.map((current) =>
      current.id === target.itineraryId
        ? {
            ...current,
            visible: true,
            gpxRoute: {
              name: current.gpxRoute?.name ?? null,
              points: mergedRoutePoints,
              originalPoints: mergedRoutePoints,
              gpxQuality: current.gpxRoute?.gpxQuality ?? 'default',
              gpxQualityPointsPerKm: current.gpxRoute?.gpxQualityPointsPerKm ?? null,
              source: 'brouter',
              routedInputsKey: getRoutingInputsSignature(current),
            },
            metrics: {
              ...current.metrics,
              distanceKm,
              ascentM: elevationMetrics
                ? Math.max(0, Math.round(elevationMetrics.ascentM))
                : undefined,
              descentM: elevationMetrics
                ? Math.max(0, Math.round(elevationMetrics.descentM))
                : undefined,
              avgSlopePercent: elevationMetrics
                ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
                : undefined,
              tarmacPercent: surfaceMetrics?.tarmacPercent,
              offroadPercent: surfaceMetrics?.offroadPercent,
            },
            timeline: nextTimeline,
            pendingTraceExtension: undefined,
          }
        : current,
    ),
  };
}

export function applyRecomputedRoute(
  project: ItineraryProject,
  target: RouteResultTarget,
  route: BrouterRoute,
  routeProfileOverride?: RouteProfilePoint[] | null,
): ItineraryProject {
  const itinerary = project.itineraries.find((item) => item.id === target.itineraryId);
  if (!itinerary) return project;
  const routedInputsKey = target.inputsSignature;
  if (!routedInputsKey || getRoutingInputsSignature(itinerary) !== routedInputsKey) {
    return project;
  }

  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = resolveRouteProfile(route, routeProfileOverride);
  const routePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  const surfacedRoutePoints = cleanGpxGlitches(applyBrouterSurfaceToRoutePoints(route, routePoints));
  const elevationMetrics = computeRouteElevationMetrics(surfacedRoutePoints);
  const surfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const auditRoutePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
    ? toStoredRoutePoints(routeProfile)
    : surfacedRoutePoints;
  const distanceM = route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(surfacedRoutePoints);
  const distanceKm = roundRouteDistanceKm(distanceM);
  const ascentM = elevationMetrics
    ? Math.max(0, Math.round(elevationMetrics.ascentM))
    : undefined;
  const descentM = elevationMetrics
    ? Math.max(0, Math.round(elevationMetrics.descentM))
    : undefined;
  const avgSlopePercent = elevationMetrics
    ? Math.round(elevationMetrics.avgSlopePercent * 10) / 10
    : undefined;
  const tarmacPercent = surfaceMetrics
    ? Math.round(surfaceMetrics.tarmacPercent)
    : undefined;
  const offroadPercent = surfaceMetrics
    ? Math.round(surfaceMetrics.offroadPercent)
    : undefined;
  const auditFindings = analyzeBrouterRoute(route, auditRoutePoints);
  const nextTimeline = projectTimelineLocationDistances(
    itinerary.timeline,
    surfacedRoutePoints,
    distanceKm,
  );
  const gpxAlreadyOk =
    routePointsEqual(itinerary.gpxRoute?.points, surfacedRoutePoints) &&
    itinerary.gpxRoute?.routedInputsKey === routedInputsKey;
  const metricsAlreadyOk =
    itinerary.metrics?.distanceKm === distanceKm &&
    itinerary.metrics?.ascentM === ascentM &&
    itinerary.metrics?.descentM === descentM &&
    itinerary.metrics?.avgSlopePercent === avgSlopePercent &&
    itinerary.metrics?.tarmacPercent === tarmacPercent &&
    itinerary.metrics?.offroadPercent === offroadPercent;
  const auditAlreadyOk = routeAuditEqual(
    itinerary.routeAudit?.findings,
    auditFindings,
  );
  if (nextTimeline === itinerary.timeline && gpxAlreadyOk && metricsAlreadyOk && auditAlreadyOk) {
    return project;
  }

  return {
    ...project,
    itineraries: project.itineraries.map((current) =>
      current.id === target.itineraryId
        ? {
            ...current,
            visible: true,
            gpxRoute: {
              name: current.gpxRoute?.name ?? null,
              points: surfacedRoutePoints,
              originalPoints: surfacedRoutePoints,
              gpxQuality: current.gpxRoute?.gpxQuality ?? 'default',
              gpxQualityPointsPerKm: current.gpxRoute?.gpxQualityPointsPerKm ?? null,
              source: 'brouter',
              routedInputsKey,
            },
            metrics: {
              ...current.metrics,
              distanceKm,
              ascentM,
              descentM,
              avgSlopePercent,
              tarmacPercent,
              offroadPercent,
            },
            timeline: nextTimeline,
            routeAudit: {
              visible: current.routeAudit?.visible ?? false,
              findings: auditFindings,
            },
          }
        : current,
    ),
  };
}