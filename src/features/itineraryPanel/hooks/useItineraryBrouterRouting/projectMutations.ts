import { analyzeBrouterRoute } from '../../lib/routeAudit/analyzeBrouterRoute';
import {
  computeRouteElevationMetrics,
  computeRouteSurfaceMetricsFromBrouter,
  extractRouteProfileFromBrouter,
} from '../../lib/route-metrics';
import type { BrouterRoute } from '../../lib/brouter';
import type { Itinerary, ItineraryProject } from '../../types';
import {
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

export function applyPendingRoutePatch(project: ItineraryProject, route: BrouterRoute): ItineraryProject {
  const itinerary = project.itineraries.find(
    (item) => item.id === project.activeItineraryId,
  );
  if (!itinerary || !itinerary.pendingRoutePatch) return project;

  const basePoints = itinerary.gpxRoute?.points ?? [];
  if (basePoints.length < 2) return project;

  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = extractRouteProfileFromBrouter(route);
  const patchRoutePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  const patchSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const mergedRoutePoints = replaceRouteSegment(
    basePoints,
    itinerary.pendingRoutePatch,
    patchRoutePoints,
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
      current.id === project.activeItineraryId
        ? {
            ...current,
            visible: true,
            gpxRoute: {
              name: current.gpxRoute?.name ?? null,
              points: mergedRoutePoints,
              source: 'brouter',
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

export function applyPendingTraceAppend(project: ItineraryProject, route: BrouterRoute): ItineraryProject {
  const itinerary = project.itineraries.find(
    (item) => item.id === project.activeItineraryId,
  );
  if (!itinerary || !itinerary.pendingTraceExtension) return project;

  const basePoints = itinerary.gpxRoute?.points ?? [];
  if (basePoints.length < 2) return project;

  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = extractRouteProfileFromBrouter(route);
  const segmentRoutePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  const segmentSurfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const mergedRoutePoints = appendRoutePoints(basePoints, segmentRoutePoints);
  const elevationMetrics = computeRouteElevationMetrics(mergedRoutePoints);
  const totalDistanceM = getRoutePointTotalDistanceM(mergedRoutePoints);
  const distanceKm = roundRouteDistanceKm(totalDistanceM);
  const surfaceMetrics = mergeSurfaceMetrics(
    itinerary.metrics,
    getRoutePointTotalDistanceM(basePoints),
    segmentSurfaceMetrics,
    route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(segmentRoutePoints),
  );
  const nextTimeline = projectTimelineLocationDistances(
    itinerary.timeline,
    mergedRoutePoints,
    distanceKm,
  );

  return {
    ...project,
    itineraries: project.itineraries.map((current) =>
      current.id === project.activeItineraryId
        ? {
            ...current,
            visible: true,
            gpxRoute: {
              name: current.gpxRoute?.name ?? null,
              points: mergedRoutePoints,
              source: 'brouter',
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

export function applyRecomputedRoute(project: ItineraryProject, route: BrouterRoute): ItineraryProject {
  const itinerary = project.itineraries.find(
    (item) => item.id === project.activeItineraryId,
  );
  if (!itinerary) return project;

  const geometryPoints = toGeometryRoutePoints(route.coordinates);
  const routeProfile = extractRouteProfileFromBrouter(route);
  const routePoints = buildStoredRoutePointsFromBrouter(
    geometryPoints,
    routeProfile,
    route.distanceM,
  );
  const elevationMetrics = computeRouteElevationMetrics(routePoints);
  const surfaceMetrics = computeRouteSurfaceMetricsFromBrouter(route);
  const auditRoutePoints: NonNullable<Itinerary['gpxRoute']>['points'] = routeProfile
    ? toStoredRoutePoints(routeProfile)
    : routePoints;
  const distanceM = route.distanceM > 0 ? route.distanceM : getRoutePointTotalDistanceM(routePoints);
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
    routePoints,
    distanceKm,
  );
  const gpxAlreadyOk = routePointsEqual(itinerary.gpxRoute?.points, routePoints);
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
      current.id === project.activeItineraryId
        ? {
            ...current,
            visible: true,
            gpxRoute: {
              name: current.gpxRoute?.name ?? null,
              points: routePoints,
              source: 'brouter',
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