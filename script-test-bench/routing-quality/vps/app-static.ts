/**
 * Variante « imports statiques » de ../app.ts pour le bundle exécuté sur le
 * VPS (build-vps.mjs) : mêmes modules de l'app, sans Vite.
 */
import * as defaults from '../../../src/features/itineraryPanel/lib/project/defaultState';
import * as sync from '../../../src/features/itineraryPanel/lib/project/syncTracageParams';
import * as brouter from '../../../src/features/itineraryPanel/lib/brouter/index';
import * as resolveReq from '../../../src/features/itineraryPanel/hooks/useItineraryBrouterRouting/resolveRouteRequest';
import * as shared from '../../../src/features/itineraryPanel/hooks/useItineraryBrouterRoutingShared/index';
import * as routeMetrics from '../../../src/features/itineraryPanel/lib/route-metrics/index';
import * as surface from '../../../src/features/itineraryPanel/lib/route-metrics/surface';
import apiHandler from '../../../api/brouter';
import type { LoadedApp } from '../app.ts';

export { buildItinerary } from '../app.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadApp(): Promise<LoadedApp> {
  return {
    metricFns: {
      parseWayTags: surface.parseWayTags,
      classifySegment: surface.classifySegment as any,
      computeRouteElevationMetrics: routeMetrics.computeRouteElevationMetrics as any,
      extractRouteProfileFromBrouter: routeMetrics.extractRouteProfileFromBrouter as any,
      buildStoredRoutePointsFromBrouter: shared.buildStoredRoutePointsFromBrouter as any,
      toGeometryRoutePoints: shared.toGeometryRoutePoints as any,
    },
    createDefaultItinerary: defaults.createDefaultItinerary as any,
    syncTracageOnActivityChange: sync.syncTracageOnActivityChange as any,
    syncTracageOnSurfaceRangeChange: sync.syncTracageOnSurfaceRangeChange as any,
    resolveItineraryRouting: brouter.resolveItineraryRouting as any,
    resolveRouteRequest: resolveReq.resolveRouteRequest as any,
    buildBrfProfile: brouter.buildBrfProfile as any,
    resolveRoadTypes: brouter.resolveRoadTypes as any,
    ensureProfileUploaded: brouter.ensureProfileUploaded,
    apiHandler: apiHandler as any,
  };
}
