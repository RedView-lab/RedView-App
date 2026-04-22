import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { ItineraryPanel } from './ItineraryPanel';
import { AddItineraryDialog } from './components/AddItineraryDialog';
import { useItineraryPoiMap } from './hooks/useItineraryPoiMap';
import { poiFeaturesToTimelineItems } from './lib/poi-to-timeline';
import {
  createDefaultItinerary,
  createDefaultProject,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from './defaultState';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
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
  addRoute,
  fitToRoute,
  removeRoute,
  isRouteOnMap,
} from './lib/route-layer';
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
  const [project, setProject] = useState<ItineraryProject>(() =>
    createDefaultProject(),
  );
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const [pendingCorridorFor, setPendingCorridorFor] = useState<string | null>(
    null,
  );
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const routeAbortRef = useRef<AbortController | null>(null);

  const active = useMemo(
    () =>
      project.itineraries.find((i) => i.id === project.activeItineraryId) ??
      null,
    [project],
  );

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
      if (isRouteOnMap(map)) {
        try { removeRoute(map); } catch { /* noop */ }
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
      if (isRouteOnMap(map)) {
        try { removeRoute(map); } catch { /* noop */ }
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
        try {
          addRoute(map, route.coordinates, [
            { lat: startLat, lon: startLon, kind: 'start' },
            { lat: endLat, lon: endLon, kind: 'end' },
          ]);
          fitToRoute(map, route.coordinates);
        } catch (e) {
          console.error('[BRouter addRoute fail]', e);
          setRouteError(e instanceof Error ? e.message : 'Erreur d\u2019affichage');
          return;
        }
        // Persist total distance on the "end" row so the timeline shows it,
        // AND store the BRouter polyline as `gpxRoute` so the POI corridor
        // search has a route to project onto (the "Rechercher" button stays
        // disabled until `gpxRoute` is set).
        const distanceKm = Math.round(route.distanceM / 100) / 10;
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
          if (endAlreadyOk && gpxAlreadyOk) return p;
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
                    timeline: curr.timeline.map((row) =>
                      row.kind === 'end' ? { ...row, distanceKm } : row,
                    ),
                  }
                : curr,
            ),
          };
        });
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

  // Re-add the route after a Mapbox style.load.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!startKey || !endKey) return;
    const onStyleLoad = () => {
      const [startLon, startLat] = startKey.split(',').map(Number);
      const [endLon, endLat] = endKey.split(',').map(Number);
      const userVia = viaKey
        ? viaKey.split('|').map((s) => {
            const [lon, lat] = s.split(',').map(Number);
            return { lat, lon };
          })
        : [];
      const via = userVia.slice(0, 14);
      if (!active) return;
      resolveItineraryRouting(active)
        .then((resolved: ResolvedRouting) => {
          const reqBase = {
            start: { lat: startLat, lon: startLon },
            end: { lat: endLat, lon: endLon },
            via,
            profile: resolved.profileId,
          };
          return climbing
            ? fetchBrouterRouteBestOfN(reqBase, 4)
            : fetchBrouterRoute(reqBase);
        })
        .then((route: BrouterRoute) => {
          try {
            if (!isRouteOnMap(map)) {
              addRoute(map, route.coordinates, [
                { lat: startLat, lon: startLon, kind: 'start' },
                { lat: endLat, lon: endLon, kind: 'end' },
              ]);
            }
          } catch { /* noop */ }
        })
        .catch(() => { /* silent on style reload */ });
    };
    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
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
      onUploadFit={() => {}}
      onCalculate={() => {}}
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

    </>
  );
}
