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

interface LatLon {
  lat: number;
  lon: number;
}

export interface RoutingEndpoints {
  start: LatLon | null;
  end: LatLon | null;
  via: LatLon[];
}

/**
 * Points routés d'un itinéraire. Sans arrivée posée, le dernier point de
 * passage hors-trace sert d'arrivée : le tracé suit chaque étape ajoutée
 * sans attendre l'arrivée.
 */
export function getRoutingEndpoints(
  itinerary: Itinerary | null | undefined,
): RoutingEndpoints {
  if (!itinerary) return { start: null, end: null, via: [] };
  const toLatLon = (item: Itinerary['timeline'][number] | undefined): LatLon | null =>
    item && item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : null;
  const via = itinerary.timeline
    .filter((item) => item.kind === 'waypoint' && !item.onRoute)
    .map(toLatLon)
    .filter((point): point is LatLon => point !== null);
  const end = toLatLon(itinerary.timeline.find((item) => item.kind === 'end')) ?? via.pop() ?? null;
  return {
    start: toLatLon(itinerary.timeline.find((item) => item.kind === 'start')),
    end,
    via,
  };
}

export function getRoutingEndpointsKey(
  itinerary: Itinerary | null | undefined,
): RoutingEndpointsKey {
  const { start, end, via } = getRoutingEndpoints(itinerary);
  const key = (point: LatLon | null) => (point ? `${point.lon},${point.lat}` : '');
  return {
    startKey: key(start),
    endKey: key(end),
    viaKey: via.map(key).join('|'),
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
    routeProfileOverride,
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
    routeProfileOverride,
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
    routeProfileOverride,
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
  // Le tracé complet couvre toutes les ancres courantes : les éditions locales
  // encore en attente (patch / extension) sont satisfaites.
  const noPendingEdit = !itinerary.pendingRoutePatch && !itinerary.pendingTraceExtension;
  if (
    nextTimeline === itinerary.timeline &&
    gpxAlreadyOk &&
    metricsAlreadyOk &&
    auditAlreadyOk &&
    noPendingEdit
  ) {
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
            pendingTraceExtension: undefined,
            pendingRoutePatch: undefined,
          }
        : current,
    ),
  };
}

/**
 * Itinéraire retombé à moins de deux points routés (dernière étape supprimée
 * avant la pose de l'arrivée) : le tracé BRouter stocké, routé pour d'autres
 * points, est retiré. Un tracé sans estampille (ancien projet) est conservé.
 */
export function applyUnroutableRouteCleared(
  project: ItineraryProject,
  itineraryId: string,
): ItineraryProject {
  const itinerary = project.itineraries.find((item) => item.id === itineraryId);
  const route = itinerary?.gpxRoute;
  if (!itinerary || !route || route.source !== 'brouter') return project;
  if (route.routedInputsKey === undefined || route.routedInputsKey === getRoutingInputsSignature(itinerary)) {
    return project;
  }
  return {
    ...project,
    itineraries: project.itineraries.map((current) =>
      current.id === itineraryId
        ? {
            ...current,
            gpxRoute: undefined,
            metrics: current.metrics
              ? {
                  ...current.metrics,
                  distanceKm: undefined,
                  ascentM: undefined,
                  descentM: undefined,
                  avgSlopePercent: undefined,
                  tarmacPercent: undefined,
                  offroadPercent: undefined,
                }
              : current.metrics,
            timeline: current.timeline.map((row) =>
              row.kind === 'end' && row.distanceKm != null ? { ...row, distanceKm: null } : row,
            ),
            routeAudit: undefined,
            prediction: null,
            pendingTraceExtension: undefined,
            pendingRoutePatch: undefined,
          }
        : current,
    ),
  };
}

/**
 * Contexte d'un affinage altimétrique (IGN / Copernicus) lancé après la 1re
 * application d'un tracé BRouter. L'affinage arrive après que le champ pending
 * a été effacé et que l'effet de routage a été relancé : il se rattache donc au
 * tracé qu'il affine (signature géométrique), pas à l'édition en attente.
 */
export interface RouteRefinementBase {
  itineraryId: string;
  /** Projet sur lequel le tracé brut a été appliqué (état avant application). */
  baseProject: ItineraryProject;
  /** Signature géométrique du tracé produit par cette application. */
  appliedGeometryKey: string;
}

/** Signature de la géométrie (lat/lon) d'un tracé, indépendante des altitudes. */
export function buildRouteGeometryKey(
  points: ReadonlyArray<{ lat: number; lon: number }> | null | undefined,
): string {
  if (!points || points.length === 0) return 'empty';
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash = Math.imul(hash ^ (value | 0), 0x01000193) >>> 0;
  };
  mix(points.length);
  for (const point of points) {
    mix(Math.round(point.lat * 1e6));
    mix(Math.round(point.lon * 1e6));
  }
  return `${points.length}:${hash.toString(36)}`;
}

/** À appeler dans l'updater de la 1re application (tracé brut). */
export function captureRouteRefinementBase(
  baseProject: ItineraryProject,
  appliedProject: ItineraryProject,
  itineraryId: string,
): RouteRefinementBase | null {
  const applied = appliedProject.itineraries.find((item) => item.id === itineraryId);
  if (!applied?.gpxRoute || applied.gpxRoute.source !== 'brouter') return null;
  return {
    itineraryId,
    baseProject,
    appliedGeometryKey: buildRouteGeometryKey(applied.gpxRoute.points),
  };
}

/**
 * Applique le profil affiné : rejoue `applyWithProfile` (la même mutation que
 * la 1re application, avec le profil affiné) sur l'état d'origine, puis n'en
 * reporte que les altitudes et les métriques qui en dépendent, à condition
 * que l'itinéraire porte toujours le tracé affiné (sinon il a été remplacé).
 */
export function applyRefinedRouteProfile(
  project: ItineraryProject,
  base: RouteRefinementBase,
  applyWithProfile: (project: ItineraryProject) => ItineraryProject,
): ItineraryProject {
  const current = project.itineraries.find((item) => item.id === base.itineraryId);
  if (!current?.gpxRoute || current.gpxRoute.source !== 'brouter') return project;
  if (buildRouteGeometryKey(current.gpxRoute.points) !== base.appliedGeometryKey) return project;

  const refinedProject = applyWithProfile(base.baseProject);
  if (refinedProject === base.baseProject) return project;
  const refinedRoute = refinedProject.itineraries.find((item) => item.id === base.itineraryId);
  const refinedPoints = refinedRoute?.gpxRoute;
  if (!refinedRoute || !refinedPoints) return project;

  return {
    ...project,
    itineraries: project.itineraries.map((item) =>
      item.id === base.itineraryId && item.gpxRoute
        ? {
            ...item,
            gpxRoute: {
              ...item.gpxRoute,
              points: refinedPoints.points,
              originalPoints: refinedPoints.originalPoints,
            },
            metrics: {
              ...item.metrics,
              ascentM: refinedRoute.metrics?.ascentM,
              descentM: refinedRoute.metrics?.descentM,
              avgSlopePercent: refinedRoute.metrics?.avgSlopePercent,
            },
            ...(item.routeAudit && refinedRoute.routeAudit
              ? { routeAudit: { ...item.routeAudit, findings: refinedRoute.routeAudit.findings } }
              : {}),
          }
        : item,
    ),
  };
}
