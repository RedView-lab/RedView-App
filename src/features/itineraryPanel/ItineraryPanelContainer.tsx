import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { ItineraryPanel } from './ItineraryPanel';
import { AddItineraryDialog } from './components/AddItineraryDialog';
import { useItineraryPoiMap } from './hooks/useItineraryPoiMap';
import { poiFeaturesToTimelineItems } from './lib/poi-to-timeline';
import { useProjectStore } from './context/ProjectStore';
import {
  createDefaultItinerary,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from './defaultState';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import { createFitPredictionEngine } from '@/features/fitPredictor/engine/api';
import {
  type PredictionConfig,
  type PredictionResult,
} from '@/features/fitPredictor';
import type { PoiFeature } from '@/features/poi/types';
import {
  fetchBrouterRoute,
  fetchBrouterRouteBestOfN,
  buildBrfProfile,
  hashBrf,
  resolveItineraryRouting,
  checkRouteWithinFrance,
  isClimbingMode,
  type BrouterRoute,
  type ResolvedRouting,
} from './lib/brouter';
import {
  upsertRouteLayer,
  removeRouteLayer,
  removeAllRouteLayers,
  listMountedRouteIds,
  setRouteEndpoints,
  clearRouteEndpoints,
  hasRouteLayer,
  fitToRoute,
} from './lib/route-layer';
import {
  computeRouteMetricsFromBrouter,
  refineMetricsWithTerrain,
} from './lib/route-metrics';
import type {
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
  TimelineView,
} from './types';

interface ItineraryPanelContainerProps {
  /** Mapbox map instance (provided by the Dashboard). */
  map: MapboxMap | null;
  /** True once the map's initial style has finished loading. */
  isMapLoaded: boolean;
  width?: number;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
  onBackToHome?: () => void;
}

type FitRuntimeStatus = 'idle' | 'ready' | 'running' | 'success' | 'error';

interface ItineraryFitRuntime {
  fitFiles: File[];
  fitFileNames: string[];
  predictionResult: PredictionResult | null;
  progress: string[];
  status: FitRuntimeStatus;
  error: string | null;
  updatedAt: string | null;
}

function createEmptyFitRuntime(): ItineraryFitRuntime {
  return {
    fitFiles: [],
    fitFileNames: [],
    predictionResult: null,
    progress: [],
    status: 'idle',
    error: null,
    updatedAt: null,
  };
}

/**
 * Front-end container for the left-dock Itinerary Panel.
 *
 * Owns:
 *  - The in-memory project state (single project, 1..n itineraries).
 *  - The "Add new itinerary" dialog (from-scratch / from-GPX).
 *  - The bridge between the active itinerary and the Mapbox map: GPX
 *    rendering + corridor POI search (via `useItineraryPoiMap`).
 *
 * Persistence (Supabase, undo stack, routing engine) will be wired later.
 */
export function ItineraryPanelContainer({
  map,
  isMapLoaded,
  width,
  onResizeStart,
  isResizing,
  onBackToHome,
}: ItineraryPanelContainerProps) {
  const { project, setProject, setItineraryName } = useProjectStore();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const [pendingCorridorFor, setPendingCorridorFor] = useState<string | null>(
    null,
  );
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const routeAbortRef = useRef<AbortController | null>(null);
  const fitInputRef = useRef<HTMLInputElement | null>(null);
  const fitUploadTargetIdRef = useRef<string | null>(null);
  const fitEngineRef = useRef<ReturnType<typeof createFitPredictionEngine> | null>(
    null,
  );
  const [fitRuntimeByItineraryId, setFitRuntimeByItineraryId] = useState<
    Record<string, ItineraryFitRuntime>
  >({});
  const fitRuntimeRef = useRef(fitRuntimeByItineraryId);
  fitRuntimeRef.current = fitRuntimeByItineraryId;

  useEffect(() => {
    const engine = createFitPredictionEngine();
    fitEngineRef.current = engine;
    return () => {
      engine.terminate();
      fitEngineRef.current = null;
    };
  }, []);

  const active = useMemo(
    () =>
      project.itineraries.find((i) => i.id === project.activeItineraryId) ??
      null,
    [project],
  );
  const activeFitRuntime = useMemo(
    () =>
      active ? fitRuntimeByItineraryId[active.id] ?? createEmptyFitRuntime() : null,
    [active, fitRuntimeByItineraryId],
  );
  const uploadFitLabel = useMemo(() => {
    const count = activeFitRuntime?.fitFiles.length ?? 0;
    if (count <= 0) return 'Upload .fit';
    return count === 1 ? '1 FIT' : `${count} FIT`;
  }, [activeFitRuntime]);
  const fitStatusText = useMemo(() => {
    if (!activeFitRuntime) return null;
    const count = activeFitRuntime.fitFiles.length;
    const countLabel =
      count <= 0 ? null : count === 1 ? '1 fit chargé' : `${count} fit chargés`;
    if (activeFitRuntime.status === 'error' && activeFitRuntime.error) {
      return activeFitRuntime.error;
    }
    if (activeFitRuntime.status === 'running') {
      const progress = activeFitRuntime.progress.at(-1);
      return progress ?? (countLabel ? `${countLabel} · calcul en cours...` : 'Calcul en cours...');
    }
    if (activeFitRuntime.status === 'success') {
      return countLabel
        ? `${countLabel} · prédiction terminée`
        : 'Prédiction terminée';
    }
    if (countLabel) {
      return countLabel;
    }
    return null;
  }, [activeFitRuntime]);
  const calculateLabel = useMemo(() => {
    if (fitStatusText) return fitStatusText;
    return 'Calculer';
  }, [fitStatusText]);
  const calculateDisabled = activeFitRuntime?.status === 'running';

  // ── Multi-route layer sync ─────────────────────────────────────────
  // For every itinerary that has a polyline (gpxRoute) we maintain its
  // own Mapbox source + line layer keyed by the itinerary id. Color,
  // opacity and visibility are reapplied on each render — cheap setPaint
  // / setLayout calls, no source rebuild unless the polyline itself
  // changed. Itineraries removed from the project also get their layers
  // cleaned up.
  //
  // The start / end markers are a single layer that follows whichever
  // itinerary is currently active — this keeps the map readable when
  // editing.
  const itineraries = project.itineraries;
  // A stable signature that flips whenever something the layer cares
  // about changes (polyline length, color, opacity, visibility, the
  // active id). We can't depend on `itineraries` directly because every
  // setProject() call recreates the array.
  const layerSignature = useMemo(() => {
    return itineraries
      .map((it) => {
        const len = it.gpxRoute?.points.length ?? 0;
        const head = it.gpxRoute?.points[0];
        const tail = it.gpxRoute?.points[len - 1];
        const headKey = head ? `${head.lon.toFixed(5)},${head.lat.toFixed(5)}` : '';
        const tailKey = tail ? `${tail.lon.toFixed(5)},${tail.lat.toFixed(5)}` : '';
        return [
          it.id,
          len,
          headKey,
          tailKey,
          it.color,
          it.opacity ?? 100,
          it.visible !== false ? 1 : 0,
        ].join(':');
      })
      .join('|');
  }, [itineraries]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const wantedIds = new Set<string>();
    for (const it of itineraries) {
      const pts = it.gpxRoute?.points;
      if (!pts || pts.length < 2) continue;
      wantedIds.add(it.id);
      const coords: [number, number][] = pts.map((p) => [p.lon, p.lat]);
      try {
        upsertRouteLayer(map, it.id, coords, {
          color: it.color,
          opacity01: (it.opacity ?? 100) / 100,
          visible: it.visible !== false,
        });
      } catch (e) {
        console.warn('[route-layer] upsert failed for', it.id, e);
      }
    }
    // Drop layers that no longer correspond to a known itinerary.
    for (const mountedId of listMountedRouteIds(map)) {
      const stillWanted = itineraries.some(
        (it) =>
          it.id.replace(/[^a-zA-Z0-9_-]/g, '_') === mountedId &&
          it.gpxRoute &&
          it.gpxRoute.points.length >= 2,
      );
      if (!stillWanted) {
        // Recover the original id (best-effort): the sanitisation only
        // touches non-alphanumeric characters, so it's good enough for
        // the lookup above. For removal we can pass the sanitised id —
        // upsert/remove use the same sanitiser.
        removeRouteLayer(map, mountedId);
      }
    }

    // Endpoint markers track the active itinerary's start/end timeline rows.
    if (active) {
      const start = active.timeline.find((r) => r.kind === 'start');
      const end = active.timeline.find((r) => r.kind === 'end');
      const endpoints: { lon: number; lat: number; kind: 'start' | 'end' }[] = [];
      if (start && start.lat != null && start.lon != null) {
        endpoints.push({ lon: start.lon, lat: start.lat, kind: 'start' });
      }
      if (end && end.lat != null && end.lon != null) {
        endpoints.push({ lon: end.lon, lat: end.lat, kind: 'end' });
      }
      if (endpoints.length > 0) setRouteEndpoints(map, endpoints);
      else clearRouteEndpoints(map);
    } else {
      clearRouteEndpoints(map);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isMapLoaded, layerSignature, project.activeItineraryId]);

  // After a Mapbox style.load wipes custom layers, re-mount everything.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      // Defer one tick so useMap's async setup finishes first.
      setTimeout(() => {
        try {
          removeAllRouteLayers(map);
          clearRouteEndpoints(map);
          for (const it of itineraries) {
            const pts = it.gpxRoute?.points;
            if (!pts || pts.length < 2) continue;
            const coords: [number, number][] = pts.map((p) => [p.lon, p.lat]);
            upsertRouteLayer(map, it.id, coords, {
              color: it.color,
              opacity01: (it.opacity ?? 100) / 100,
              visible: it.visible !== false,
            });
          }
          if (active) {
            const start = active.timeline.find((r) => r.kind === 'start');
            const end = active.timeline.find((r) => r.kind === 'end');
            const endpoints: { lon: number; lat: number; kind: 'start' | 'end' }[] = [];
            if (start && start.lat != null && start.lon != null) {
              endpoints.push({ lon: start.lon, lat: start.lat, kind: 'start' });
            }
            if (end && end.lat != null && end.lon != null) {
              endpoints.push({ lon: end.lon, lat: end.lat, kind: 'end' });
            }
            if (endpoints.length > 0) setRouteEndpoints(map, endpoints);
          }
        } catch {
          /* noop */
        }
      }, 0);
    };
    map.on('style.load', onStyleLoad);
    return () => {
      map.off('style.load', onStyleLoad);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isMapLoaded, layerSignature, project.activeItineraryId]);

  /**
   * After a POI corridor search completes, replace the previously-injected
   * `kind: 'poi'` rows of the *target* itinerary with fresh ones — sorted
   * by their projected distance from the start so the feuille de route
   * shows them in physical order between Départ and Fin.
   *
   * The target is captured at call time via the active id at fire-time so
   * that switching itineraries mid-search doesn't pollute the wrong one.
   */
  const activeIdRef = useRef(project.activeItineraryId);
  activeIdRef.current = project.activeItineraryId;

  const handleCorridorComplete = useCallback((features: PoiFeature[]) => {
    const targetId = activeIdRef.current;
    setProject((p) => {
      const target = p.itineraries.find((i) => i.id === targetId);
      if (!target) return p;
      const route = target.gpxRoute?.points;
      if (!route || route.length < 2) return p;

      const newPoiRows = poiFeaturesToTimelineItems(features, route);

      // Strip previously-injected POI rows and merge fresh ones in
      // distance order between Départ and Fin (waypoints/pauses keep
      // their author-defined positions).
      const stripped = target.timeline.filter((r) => r.kind !== 'poi');
      const endIdx = stripped.findIndex((r) => r.kind === 'end');
      const insertAt = endIdx >= 0 ? endIdx : stripped.length;
      const merged = [
        ...stripped.slice(0, insertAt),
        ...newPoiRows,
        ...stripped.slice(insertAt),
      ];

      return {
        ...p,
        itineraries: p.itineraries.map((it) =>
          it.id === targetId ? { ...it, timeline: merged } : it,
        ),
      };
    });
  }, []);

  const {
    loading: poiLoading,
    error: poiError,
    poiCount,
    corridorProgress: poiProgress,
    searchCorridor,
    hasGpxRoute,
    hasEnabledCategories,
  } = useItineraryPoiMap(map, isMapLoaded, active, handleCorridorComplete);

  const updateActive = useCallback(
    (mut: (it: ItineraryProject['itineraries'][number]) => void) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) => {
          if (it.id !== prev.activeItineraryId) return it;
          const copy = structuredClone(it);
          mut(copy);
          return copy;
        }),
      }));
    },
    [],
  );

  const updateFitRuntime = useCallback(
    (
      itineraryId: string,
      mut: (current: ItineraryFitRuntime) => ItineraryFitRuntime,
    ) => {
      setFitRuntimeByItineraryId((prev) => {
        const current = prev[itineraryId] ?? createEmptyFitRuntime();
        const next = mut(current);
        if (next === current) return prev;
        return { ...prev, [itineraryId]: next };
      });
    },
    [],
  );

  const addItinerary = useCallback(
    (overrides: Partial<ReturnType<typeof createDefaultItinerary>> = {}) => {
      let createdId: string | null = null;
      setProject((p) => {
        const idx = p.itineraries.length;
        const color =
          ITINERARY_COLORS[idx % ITINERARY_COLORS.length] ??
          ITINERARY_COLORS[0];
        const base = createDefaultItinerary(idx + 1, color);
        const next = { ...base, ...overrides };
        createdId = next.id;
        return {
          ...p,
          itineraries: [...p.itineraries, next],
          activeItineraryId: next.id,
        };
      });
      return createdId;
    },
    [],
  );

  const handleFitInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const itineraryId = fitUploadTargetIdRef.current;
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = '';
      if (!itineraryId) return;

      const fitFiles = files.filter((file) => /\.fit$/i.test(file.name));
      if (fitFiles.length === 0) {
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          fitFiles: [],
          fitFileNames: [],
          predictionResult: null,
          progress: [],
          status: 'error',
          error: 'Aucun fichier FIT valide sélectionné.',
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      updateFitRuntime(itineraryId, (current) => ({
        ...current,
        fitFiles,
        fitFileNames: fitFiles.map((file) => file.name),
        predictionResult: null,
        progress: [],
        status: 'ready',
        error: null,
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateFitRuntime],
  );

  const handleCalculatePrediction = useCallback(() => {
    const itinerary = active;
    if (!itinerary) return;

    const runtime = fitRuntimeRef.current[itinerary.id] ?? createEmptyFitRuntime();
    if (runtime.fitFiles.length === 0) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: 'Chargez au moins un fichier FIT avant de calculer.',
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    if (!itinerary.gpxRoute || itinerary.gpxRoute.points.length < 2) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: 'L’itinéraire actif n’a pas encore de trace GPX exploitable.',
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const engine = fitEngineRef.current;
    if (!engine) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: 'Le moteur de prediction FIT n’est pas prêt.',
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const itineraryId = itinerary.id;
    const gpxFile = buildRouteGpxFile(itinerary);
    const config = buildPredictionConfigFromRhythm(itinerary.rhythm);

    updateFitRuntime(itineraryId, (current) => ({
      ...current,
      predictionResult: null,
      progress: [],
      status: 'running',
      error: null,
      updatedAt: new Date().toISOString(),
    }));

    void engine
      .predict(runtime.fitFiles, gpxFile, config, (message: string) => {
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          progress: [...current.progress.slice(-19), message],
          status: 'running',
        }));
      })
      .then((result: PredictionResult) => {
        setProject((prev) => ({
          ...prev,
          itineraries: prev.itineraries.map((curr) =>
            curr.id === itineraryId
              ? {
                  ...curr,
                  metrics: {
                    ...curr.metrics,
                    durationSec: result.total_time_s,
                  },
                }
              : curr,
          ),
        }));
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          predictionResult: result,
          status: 'success',
          error: null,
          updatedAt: new Date().toISOString(),
        }));
      })
      .catch((error: unknown) => {
        console.error('[fit-predictor] prediction failed', error);
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          predictionResult: null,
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Erreur inconnue pendant la prediction FIT.',
          updatedAt: new Date().toISOString(),
        }));
      });
  }, [active, updateFitRuntime]);

  // After importing a GPX, automatically run a corridor search so the user
  // immediately sees POIs along the freshly-loaded track.
  useEffect(() => {
    if (!pendingCorridorFor) return;
    if (!active || active.id !== pendingCorridorFor) return;
    if (!hasGpxRoute || !hasEnabledCategories || !isMapLoaded) return;
    // Defer one tick so `usePoi` has the latest gpxRoute / categories refs.
    const handle = setTimeout(() => {
      searchCorridor();
      setPendingCorridorFor(null);
    }, 50);
    return () => clearTimeout(handle);
  }, [
    pendingCorridorFor,
    active,
    hasGpxRoute,
    hasEnabledCategories,
    isMapLoaded,
    searchCorridor,
  ]);

  const poiLoadDisabled = !hasGpxRoute || !hasEnabledCategories;
  const poiLoadDisabledReason = !hasGpxRoute
    ? 'Importez un fichier GPX pour rechercher les POI le long du parcours.'
    : !hasEnabledCategories
      ? 'Activez au moins une catégorie ci-dessus.'
      : null;

  // ── BRouter routing ───────────────────────────────────────────────
  // Compute a route whenever the active itinerary has both a start and an
  // end with valid lon/lat. Previous in-flight requests are aborted.
  //
  // IMPORTANT: deps are PRIMITIVE strings, not object memos. After each
  // successful fetch we call setProject() to persist distanceKm on the
  // "end" row — that recreates `active`, and useMemo objects derived from
  // it would change identity each render → infinite refetch loop.
  const startKey = (() => {
    const r = active?.timeline.find((i) => i.kind === 'start');
    return r && r.lat != null && r.lon != null ? `${r.lon},${r.lat}` : '';
  })();
  const endKey = (() => {
    const r = active?.timeline.find((i) => i.kind === 'end');
    return r && r.lat != null && r.lon != null ? `${r.lon},${r.lat}` : '';
  })();
  const viaKey = active
    ? active.timeline
        .filter((i) => i.kind === 'waypoint' && i.lat != null && i.lon != null)
        .map((i) => `${i.lon},${i.lat}`)
        .join('|')
    : '';
  // Dénivelé slider: above CLIMBING_SLIDER_THRESHOLD (=70) we switch to
  // EE3D-style climbing mode — the BRF inflates flat-road costfactors
  // and the routing layer fans out best-of-N alternatives, picking
  // whichever climbs the most.
  const profileId = active?.profileId ?? 'gravel-default';
  const climbing = active ? isClimbingMode(active.priorities) : false;

  // Stable signature derived from the FULL generated BRF (basic + expert).
  // Hashing the BRF means: if any panel knob (priorities, road types,
  // expert overrides) actually changes how BRouter computes costs, the
  // hash flips and the effect re-runs. Otherwise we sit on the cache.
  const [routeWarnings, setRouteWarnings] = useState<string[]>([]);
  // Stabilise deps: only recompute when the actual BRF inputs change,
  // not on every project update (e.g. storing distanceKm/gpxRoute back).
  const prioritiesJson = active ? JSON.stringify(active.priorities) : '';
  const roadTypesJson = active ? JSON.stringify(active.roadTypes) : '';
  const expertJson = active ? JSON.stringify(active.expertProfile) : '';
  const brfHash = useMemo(() => {
    if (!active) return '';
    try {
      const brf = buildBrfProfile({
        priorities: active.priorities,
        roadTypes: active.roadTypes,
        expert: active.expertProfile,
      });
      const h = hashBrf(brf);
      console.log(
        '[BRouter] BRF hash =',
        h,
        '| size =',
        brf.length,
        'B | profile =',
        active.profileId,
        '| priorities =',
        active.priorities,
      );
      return h;
    } catch (e) {
      console.warn('[BRouter] buildBrfProfile threw:', e);
      return '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prioritiesJson, roadTypesJson, expertJson]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!startKey || !endKey) {
      if (active && hasRouteLayer(map, active.id)) {
        try { removeRouteLayer(map, active.id); } catch { /* noop */ }
      }
      setRouteError(null);
      return;
    }

    const [startLon, startLat] = startKey.split(',').map(Number);
    const [endLon, endLat] = endKey.split(',').map(Number);
    const userVia = viaKey
      ? viaKey.split('|').map((s) => {
          const [lon, lat] = s.split(',').map(Number);
          return { lat, lon };
        })
      : [];
    const via = userVia.slice(0, 14);

    // ── France-only guard (temporary) ─────────────────────────────
    const allPoints = [
      { lat: startLat, lon: startLon },
      { lat: endLat, lon: endLon },
      ...via,
    ];
    const bounds = checkRouteWithinFrance(allPoints);
    if (!bounds.ok) {
      if (active && hasRouteLayer(map, active.id)) {
        try { removeRouteLayer(map, active.id); } catch { /* noop */ }
      }
      setRouteError(bounds.reason ?? 'Itinéraire hors zone autorisée.');
      setRouteLoading(false);
      return;
    }

    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    setRouteLoading(true);
    setRouteError(null);

    const itineraryForRouting = active;
    if (!itineraryForRouting) return;

    const t0 = performance.now();
    console.log(
      '[BRouter] recompute START hash=', brfHash,
      'climbing=', climbing,
      'start=', startKey, 'end=', endKey,
      'via=', viaKey || '∅',
    );

    // Two-stage: 1) upload (cached) custom profile, 2) route with it.
    // In climbing mode we run BRouter with alternativeidx 0..3 in
    // parallel and keep whichever variant climbs the most (EE3D recipe).
    resolveItineraryRouting(itineraryForRouting, ctrl.signal)
      .then((resolved: ResolvedRouting) => {
        if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError');
        console.log(
          '[BRouter] profile resolved →', resolved.profileId,
          '| brf=', resolved.brf ? `${resolved.brf.length}B` : 'stock',
          '| warnings=', resolved.roadTypes.warnings.length,
        );
        setRouteWarnings(resolved.roadTypes.warnings);
        const reqBase = {
          start: { lat: startLat, lon: startLon },
          end: { lat: endLat, lon: endLon },
          via,
          profile: resolved.profileId,
          signal: ctrl.signal,
        };
        return climbing
          ? fetchBrouterRouteBestOfN(reqBase, 4)
          : fetchBrouterRoute(reqBase);
      })
      .then((route: BrouterRoute) => {
        if (ctrl.signal.aborted) return;
        console.log(
          '[BRouter] route OK in', Math.round(performance.now() - t0), 'ms',
          '| dist=', (route.distanceM / 1000).toFixed(2), 'km',
          '| ascent=', Math.round(route.ascentM), 'm',
          '| pts=', route.coordinates.length,
        );
        // Layer mounting is handled by the multi-route master effect
        // — it will pick up the new gpxRoute from the store mutation
        // below. We still want to re-frame the map on a fresh route.
        try {
          fitToRoute(map, route.coordinates);
        } catch (e) {
          console.warn('[BRouter] fitToRoute failed', e);
        }
        // Persist total distance on the "end" row so the timeline shows it,
        // AND store the BRouter polyline as `gpxRoute` so the POI corridor
        // search has a route to project onto (the "Rechercher" button stays
        // disabled until `gpxRoute` is set).
        const distanceKm = Math.round(route.distanceM / 100) / 10;
        // Compute the rich metrics from the BRouter `messages` array
        // (per-vertex elevation + surface tags). Falls back to BRouter's
        // own `filtered ascend` totals when messages are unavailable.
        const detailed = computeRouteMetricsFromBrouter(route);
        const ascentM = detailed
          ? Math.max(0, Math.round(detailed.ascentM))
          : Math.max(0, Math.round(route.ascentM));
        const descentM = detailed
          ? Math.max(0, Math.round(detailed.descentM))
          : Math.max(0, Math.round(route.descentM));
        const avgSlopePercent = detailed
          ? Math.round(detailed.avgSlopePercent * 10) / 10
          : undefined;
        const tarmacPercent = detailed
          ? Math.round(detailed.tarmacPercent)
          : undefined;
        const offroadPercent = detailed
          ? Math.round(detailed.offroadPercent)
          : undefined;
        console.log(
          '[BRouter] metrics:',
          'ascent=', ascentM, 'm',
          '| descent=', descentM, 'm',
          '| avg slope=', avgSlopePercent, '%',
          '| tarmac=', tarmacPercent, '% off-road=', offroadPercent, '%',
        );
        const routePoints = route.coordinates.map((c: [number, number]) => ({
          lat: c[1],
          lon: c[0],
        }));
        setProject((p) => {
          const it = p.itineraries.find((x) => x.id === p.activeItineraryId);
          if (!it) return p;
          const endRow = it.timeline.find((r) => r.kind === 'end');
          const endAlreadyOk = endRow?.distanceKm === distanceKm;
          const gpxAlreadyOk =
            it.gpxRoute?.points.length === routePoints.length &&
            it.gpxRoute?.points[0]?.lat === routePoints[0]?.lat &&
            it.gpxRoute?.points[0]?.lon === routePoints[0]?.lon;
          const metricsAlreadyOk =
            it.metrics?.distanceKm === distanceKm &&
            it.metrics?.ascentM === ascentM &&
            it.metrics?.descentM === descentM &&
            it.metrics?.avgSlopePercent === avgSlopePercent &&
            it.metrics?.tarmacPercent === tarmacPercent &&
            it.metrics?.offroadPercent === offroadPercent;
          if (endAlreadyOk && gpxAlreadyOk && metricsAlreadyOk) return p;
          return {
            ...p,
            itineraries: p.itineraries.map((curr) =>
              curr.id === p.activeItineraryId
                ? {
                    ...curr,
                    gpxRoute: {
                      name: curr.gpxRoute?.name ?? null,
                      points: routePoints,
                      source: 'brouter',
                    },
                    metrics: {
                      ...curr.metrics,
                      distanceKm,
                      ascentM,
                      descentM,
                      avgSlopePercent,
                      tarmacPercent,
                      offroadPercent,
                    },
                    timeline: curr.timeline.map((row) =>
                      row.kind === 'end' ? { ...row, distanceKm } : row,
                    ),
                  }
                : curr,
            ),
          };
        });

        // Schedule a refinement pass once the terrain tiles around the
        // route have had time to load. Mapbox's terrain DEM is ~10 m at
        // z14 (vs. BRouter's ~30 m SRTM); when the user has downloaded a
        // LIDAR tile this drops to 0.4 m. We sample every BRouter vertex
        // and recompute ascent/descent/slope.
        if (detailed) {
          const refineTimer = window.setTimeout(() => {
            const queryEle = (lng: number, lat: number) => {
              try {
                return map.queryTerrainElevation?.([lng, lat]) ?? null;
              } catch {
                return null;
              }
            };
            const refined = refineMetricsWithTerrain(route, queryEle);
            if (!refined) return;
            const rAscent = Math.max(0, Math.round(refined.ascentM));
            const rDescent = Math.max(0, Math.round(refined.descentM));
            const rAvg = Math.round(refined.avgSlopePercent * 10) / 10;
            console.log(
              '[BRouter] terrain-refined metrics:',
              'ascent=', rAscent, 'm',
              '| descent=', rDescent, 'm',
              '| avg slope=', rAvg, '%',
            );
            setProject((p) => {
              const it = p.itineraries.find((x) => x.id === p.activeItineraryId);
              if (!it) return p;
              if (
                it.metrics?.ascentM === rAscent &&
                it.metrics?.descentM === rDescent &&
                it.metrics?.avgSlopePercent === rAvg
              )
                return p;
              return {
                ...p,
                itineraries: p.itineraries.map((curr) =>
                  curr.id === p.activeItineraryId
                    ? {
                        ...curr,
                        metrics: {
                          ...curr.metrics,
                          ascentM: rAscent,
                          descentM: rDescent,
                          avgSlopePercent: rAvg,
                        },
                      }
                    : curr,
                ),
              };
            });
          }, 1500);
          ctrl.signal.addEventListener('abort', () =>
            window.clearTimeout(refineTimer),
          );
        }
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        console.error('[BRouter fetch fail]', e);
        setRouteError(e instanceof Error ? e.message : 'Erreur BRouter');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setRouteLoading(false);
      });

    return () => ctrl.abort();
    // active is intentionally omitted — brfHash is the stable signature
    // derived from it; including `active` would re-trigger on every
    // setProject().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isMapLoaded, startKey, endKey, viaKey, profileId, brfHash, climbing]);

  const panel = (
    <ItineraryPanel
      project={project}
      profiles={DEFAULT_PROFILES}
      width={width}
      isResizing={isResizing}
      onResizeStart={onResizeStart}
      onBackToHome={onBackToHome}
      onSaveProject={() => {
        setProject((p) => ({
          ...p,
          savedAt: new Date().toISOString(),
          sizeBytes: p.sizeBytes ?? 4096,
        }));
      }}
      onDownloadProject={() => {}}
      onShareProject={() => {}}
      onRenameProject={(next) => setProject((p) => ({ ...p, name: next }))}
      onSelectItinerary={(id) =>
        setProject((p) => ({ ...p, activeItineraryId: id }))
      }
      onAddItinerary={() => addItinerary()}
      onOpenAddItinerary={() => setAddDialogOpen(true)}
      onAddItineraryFromGpx={async (file) => {
        const route = await parseGpxFile(file);
        addItinerary({
          name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
          gpxRoute: { name: route.name, points: route.points },
        });
      }}
      onRemoveItinerary={(id) =>
        setProject((p) => {
          if (p.itineraries.length <= 1) return p;
          const remaining = p.itineraries.filter((i) => i.id !== id);
          const nextActive =
            p.activeItineraryId === id ? remaining[0].id : p.activeItineraryId;
          return { ...p, itineraries: remaining, activeItineraryId: nextActive };
        })
      }
      onRenameItinerary={setItineraryName}
      onChangeMode={(mode: PanelMode) =>
        setProject((p) => ({ ...p, activeMode: mode }))
      }
      onChangeProfile={(id) =>
        updateActive((it) => {
          it.profileId = id;
        })
      }
      onUndo={() => {}}
      onRedo={() => {}}
      canUndo={false}
      canRedo={false}
      onSaveProfile={() => {}}

      onChangePriority={(key: keyof PrioritiesState, value) =>
        updateActive((it) => {
          it.priorities[key] = value;
        })
      }
      onChangeRoadType={(key, value) =>
        updateActive((it) => {
          (it.roadTypes[key] as RoadTypesState[typeof key]) = value;
        })
      }
      onChangeRhythm={(key, value) =>
        updateActive((it) => {
          (it.rhythm[key] as RhythmState[typeof key]) = value;
        })
      }
      onUploadFit={() => {
        if (!active) return;
        fitUploadTargetIdRef.current = active.id;
        fitInputRef.current?.click();
      }}
      uploadFitLabel={uploadFitLabel}
      onCalculate={() => {
        handleCalculatePrediction();
      }}
      calculateLabel={calculateLabel}
      calculateDisabled={calculateDisabled}
      onChangePoiEntry={(category, next) =>
        updateActive((it) => {
          it.poi[category] = next;
        })
      }
      onChangePoiRefine={(value) =>
        updateActive((it) => {
          it.poi.refineResults = value;
        })
      }
      onOpenPoiCategories={() => {}}
      onLoadPois={() => searchCorridor()}
      poiLoading={poiLoading}
      poiProgress={poiProgress}
      poiCount={poiCount}
      poiError={poiError}
      poiLoadDisabled={poiLoadDisabled}
      poiLoadDisabledReason={poiLoadDisabledReason}
      onChangeTimelineView={(view: TimelineView) =>
        setProject((p) => ({ ...p, timelineView: view }))
      }
      onAddTimelineItem={() =>
        updateActive((it) => {
          const newId = `wp-${Date.now()}`;
          const endIdx = it.timeline.findIndex((i) => i.kind === 'end');
          const insertAt = endIdx >= 0 ? endIdx : it.timeline.length;
          it.timeline.splice(insertAt, 0, {
            id: newId,
            kind: 'waypoint',
            label: 'Nouveau point',
            distanceKm: null,
          });
        })
      }
      onToggleTimelineItem={(id, visible) =>
        updateActive((it) => {
          const row = it.timeline.find((i) => i.id === id);
          if (row) row.visible = visible;
        })
      }
      onRemoveTimelineItem={(id) =>
        updateActive((it) => {
          it.timeline = it.timeline.filter(
            (i) => i.id !== id || i.kind === 'start' || i.kind === 'end',
          );
        })
      }
      onFavoriteTimelineItem={(id, favorite) =>
        updateActive((it) => {
          const row = it.timeline.find((i) => i.id === id);
          if (row) row.favorite = favorite;
        })
      }
      onSearchTimeline={() => {}}
      onOpenTimelineSettings={() => {}}
      onSelectTimelinePlace={(id, place) =>
        updateActive((it) => {
          const row = it.timeline.find((i) => i.id === id);
          if (!row) return;
          row.label = place.name;
          row.lat = place.lat;
          row.lon = place.lon;
        })
      }
      routeLoading={routeLoading}
      routeError={routeError}
      routeWarnings={routeWarnings}
    />
  );

  return (
    <>
      {panel}
      <AddItineraryDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onPickScratch={() => addItinerary()}
        onPickGpx={async (file) => {
          const route = await parseGpxFile(file);
          const id = addItinerary({
            name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
            gpxRoute: { name: route.name, points: route.points },
          });
          if (id) setPendingCorridorFor(id);
        }}
      />
      <input
        ref={fitInputRef}
        type="file"
        accept=".fit"
        multiple
        hidden
        onChange={handleFitInputChange}
      />

    </>
  );
}

function buildPredictionConfigFromRhythm(rhythm: RhythmState): PredictionConfig {
  const config: PredictionConfig = {
    pacing_factor: 1,
  };

  if (rhythm.gender && rhythm.gender !== 'default') {
    config.gender = rhythm.gender;
  }

  if (typeof rhythm.ftp === 'number' && rhythm.ftp > 0) {
    config.ftp_w = rhythm.ftp;
  }

  if (
    typeof rhythm.systemWeightKg === 'number' &&
    rhythm.systemWeightKg > 0
  ) {
    config.mass_kg = rhythm.systemWeightKg;
  }

  if (rhythm.startTime) {
    const startTimeH = parseTimeToHourDecimal(rhythm.startTime);
    if (startTimeH !== null) {
      config.start_time_h = startTimeH;
    }
  }

  return config;
}

function buildRouteGpxFile(
  itinerary: ItineraryProject['itineraries'][number],
): File {
  const routeName = escapeXml(itinerary.gpxRoute?.name ?? itinerary.name);
  const points = itinerary.gpxRoute?.points ?? [];
  const trackPoints = points
    .map(
      (point) =>
        `      <trkpt lat="${point.lat}" lon="${point.lon}"></trkpt>`,
    )
    .join('\n');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RedView" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    `    <name>${routeName}</name>`,
    '    <trkseg>',
    trackPoints,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ].join('\n');

  return new File([xml], `${slugifyFilename(itinerary.name || 'itinerary')}.gpx`, {
    type: 'application/gpx+xml',
  });
}

function parseTimeToHourDecimal(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours >= 24 ||
    minutes < 0 ||
    minutes >= 60
  ) {
    return null;
  }
  return hours + minutes / 60;
}

function slugifyFilename(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '') || 'itinerary';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
