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
import { getRoutingInputsSignature, routeStampMatches } from './routingInputs';
import {
  applyBrouterSurfaceToRoutePoints,
  appendRoutePoints,
  buildStoredRoutePointsFromBrouter,
  getRoutePointTotalDistanceM,
  mergeSurfaceMetrics,
  projectTimelineLocationDistances,
  reElevateMessageProfile,
  recomputeApproxSurfaceMetrics,
  replaceRouteSegment,
  roundRouteDistanceKm,
  routeAuditEqual,
  routePointsEqual,
  toGeometryRoutePoints,
  toStoredRoutePoints,
} from '../useItineraryBrouterRoutingShared';

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

/**
 * Profil des `messages` BRouter (audit, repli sans altitudes de géométrie). Le
 * profil affiné suit les sommets de la géométrie : ses altitudes sont reportées
 * sur les lignes de messages, jamais l'inverse.
 */
function resolveRouteProfile(
  route: BrouterRoute,
  routeProfileOverride?: RouteProfilePoint[] | null,
): RouteProfilePoint[] | null {
  const messageProfile = extractRouteProfileFromBrouter(route);
  if (!routeProfileOverride || routeProfileOverride.length < 2) return messageProfile;
  return messageProfile ? reElevateMessageProfile(messageProfile, routeProfileOverride) : routeProfileOverride;
}

/**
 * `routedPatch` : bornes réellement routées quand la fenêtre locale a été
 * élargie (cf. widenUnjoinedRoutePatchWindow) ; par défaut, le patch en attente.
 */
export function applyPendingRoutePatch(
  project: ItineraryProject,
  target: RouteResultTarget,
  route: BrouterRoute,
  routeProfileOverride?: RouteProfilePoint[] | null,
  routedPatch?: Itinerary['pendingRoutePatch'],
): ItineraryProject {
  const itinerary = project.itineraries.find((item) => item.id === target.itineraryId);
  if (!itinerary || !itinerary.pendingRoutePatch) return project;
  if (JSON.stringify(itinerary.pendingRoutePatch) !== target.pendingKey) return project;
  const patch = routedPatch ?? itinerary.pendingRoutePatch;

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
  const splicedRoutePoints = replaceRouteSegment(basePoints, patch, surfacedPatchRoutePoints);
  // Jonction impossible sans ligne droite (vérifiée avant application, cf.
  // resolveElasticRoutePatch) : le tracé stocké n'est jamais recollé de travers.
  if (!splicedRoutePoints) return project;
  const mergedRoutePoints = cleanGpxGlitches(splicedRoutePoints);
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
    patch,
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
  const appendedRoutePoints = appendRoutePoints(basePoints, surfacedSegmentRoutePoints);
  // Extension qui ne repart pas de la fin du tracé : jamais de ligne droite.
  if (!appendedRoutePoints) return project;
  const mergedRoutePoints = cleanGpxGlitches(appendedRoutePoints);
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
  if (route.routedInputsKey === undefined || routeStampMatches(itinerary, route.routedInputsKey)) {
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
function buildRouteGeometryKey(
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
