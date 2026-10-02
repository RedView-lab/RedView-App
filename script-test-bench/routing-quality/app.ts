/**
 * Chargement des modules de l'app (Vite SSR : alias `@/`, `import.meta.env`)
 * et du handler `api/brouter.ts`, + construction d'un itinéraire à partir
 * d'une config de bench, exactement comme le fait le panneau Traçage.
 */
import { loadSrc } from '../audit/b-loader.ts';
import type { AppMetricFns } from './metrics.ts';
import type { BenchConfig, Pt } from './scenarios.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LoadedApp {
  metricFns: AppMetricFns;
  createDefaultItinerary(index?: number): any;
  syncTracageOnActivityChange(activity: string, mode: string, tolerance?: number): { roadTypes: any; priorities?: any };
  syncTracageOnSurfaceRangeChange(min: string, max: string, activity: string): { roadTypes: any };
  resolveItineraryRouting(it: any, signal?: AbortSignal): Promise<{ profileId: string; brf: string; roadTypes: { warnings: string[] } }>;
  resolveRouteRequest(args: {
    itinerary: any;
    signal: AbortSignal;
    requestBase: { start: Pt; end: Pt; via?: Pt[]; signal?: AbortSignal };
    setRouteWarnings: (w: string[]) => void;
  }): Promise<{ route: any; resolvedWarnings: string[]; resolved: { profileId: string } }>;
  buildBrfProfile(inputs: any): string;
  resolveRoadTypes(rt: any): { effective: any; warnings: string[] };
  ensureProfileUploaded(brf: string, signal?: AbortSignal): Promise<string>;
  apiHandler(req: unknown, res: unknown): Promise<unknown>;
}

export async function loadApp(): Promise<LoadedApp> {
  const defaults = await loadSrc<any>('src/features/itineraryPanel/lib/project/defaultState.ts');
  const sync = await loadSrc<any>('src/features/itineraryPanel/lib/project/syncTracageParams.ts');
  const brouter = await loadSrc<any>('src/features/itineraryPanel/lib/brouter/index.ts');
  const resolveReq = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/resolveRouteRequest.ts');
  const shared = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRoutingShared/index.ts');
  const routeMetrics = await loadSrc<any>('src/features/itineraryPanel/lib/route-metrics/index.ts');
  const surface = await loadSrc<any>('src/features/itineraryPanel/lib/route-metrics/surface.ts');
  const api = await loadSrc<any>('api/brouter.ts');

  return {
    metricFns: {
      parseWayTags: surface.parseWayTags,
      classifySegment: surface.classifySegment,
      computeRouteElevationMetrics: routeMetrics.computeRouteElevationMetrics,
      extractRouteProfileFromBrouter: routeMetrics.extractRouteProfileFromBrouter,
      buildStoredRoutePointsFromBrouter: shared.buildStoredRoutePointsFromBrouter,
      toGeometryRoutePoints: shared.toGeometryRoutePoints,
    },
    createDefaultItinerary: defaults.createDefaultItinerary,
    syncTracageOnActivityChange: sync.syncTracageOnActivityChange,
    syncTracageOnSurfaceRangeChange: sync.syncTracageOnSurfaceRangeChange,
    resolveItineraryRouting: brouter.resolveItineraryRouting,
    resolveRouteRequest: resolveReq.resolveRouteRequest,
    buildBrfProfile: brouter.buildBrfProfile,
    resolveRoadTypes: brouter.resolveRoadTypes,
    ensureProfileUploaded: brouter.ensureProfileUploaded,
    apiHandler: api.default,
  };
}

/** Itinéraire tel que le produit le panneau : preset d'activité + mode, puis réglages. */
export function buildItinerary(app: LoadedApp, config: BenchConfig): any {
  const base = app.createDefaultItinerary(1);
  const presetSync = app.syncTracageOnActivityChange(config.activity, config.mode, 10);
  let roadTypes = { ...base.roadTypes, ...presetSync.roadTypes };
  if (config.surfaceRange) {
    roadTypes = {
      ...roadTypes,
      ...app.syncTracageOnSurfaceRangeChange(config.surfaceRange[0], config.surfaceRange[1], config.activity).roadTypes,
    };
  }
  roadTypes = { ...roadTypes, ...(config.patch ?? {}) };
  const discipline = config.activity === 'running' ? 'running' : config.activity === 'trail' ? 'trail' : 'bike';
  return {
    ...base,
    profileId: config.activity,
    discipline,
    priorities: { ...base.priorities, ...(presetSync.priorities ?? {}) },
    roadTypes,
  };
}
