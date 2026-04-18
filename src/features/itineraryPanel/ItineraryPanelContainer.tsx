import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { ItineraryPanel } from './ItineraryPanel';
import { AddItineraryDialog } from './components/AddItineraryDialog';
import { useItineraryPoiMap } from './hooks/useItineraryPoiMap';
import {
  createDefaultItinerary,
  createDefaultProject,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from './defaultState';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import {
  fetchBrouterRoute,
  panelProfileToBrouter,
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
  onClose?: () => void;
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
  onClose,
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

  const {
    loading: poiLoading,
    error: poiError,
    poiCount,
    corridorProgress: poiProgress,
    searchCorridor,
    hasGpxRoute,
    hasEnabledCategories,
  } = useItineraryPoiMap(map, isMapLoaded, active);

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
  const startPoint = useMemo(() => {
    const row = active?.timeline.find((i) => i.kind === 'start');
    if (!row || row.lat == null || row.lon == null) return null;
    return { lat: row.lat, lon: row.lon };
  }, [active]);
  const endPoint = useMemo(() => {
    const row = active?.timeline.find((i) => i.kind === 'end');
    if (!row || row.lat == null || row.lon == null) return null;
    return { lat: row.lat, lon: row.lon };
  }, [active]);
  const viaPoints = useMemo(() => {
    if (!active) return [] as { lat: number; lon: number }[];
    return active.timeline
      .filter((i) => i.kind === 'waypoint' && i.lat != null && i.lon != null)
      .map((i) => ({ lat: i.lat as number, lon: i.lon as number }));
  }, [active]);
  const profileId = active?.profileId ?? 'gravel-default';

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!startPoint || !endPoint) {
      // Drop a stale route when the user clears one of the endpoints.
      if (isRouteOnMap(map)) {
        try { removeRoute(map); } catch { /* noop */ }
      }
      setRouteError(null);
      return;
    }

    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    setRouteLoading(true);
    setRouteError(null);

    fetchBrouterRoute({
      start: startPoint,
      end: endPoint,
      via: viaPoints,
      profile: panelProfileToBrouter(profileId),
      signal: ctrl.signal,
    })
      .then((route) => {
        if (ctrl.signal.aborted) return;
        try {
          addRoute(map, route.coordinates, [
            { ...startPoint, kind: 'start' },
            { ...endPoint, kind: 'end' },
          ]);
          fitToRoute(map, route.coordinates);
        } catch (e) {
          setRouteError(e instanceof Error ? e.message : 'Erreur d\u2019affichage');
          return;
        }
        // Persist total distance on the "end" row so the timeline shows it.
        const distanceKm = Math.round(route.distanceM / 100) / 10;
        setProject((p) => ({
          ...p,
          itineraries: p.itineraries.map((it) =>
            it.id === p.activeItineraryId
              ? {
                  ...it,
                  timeline: it.timeline.map((row) =>
                    row.kind === 'end' ? { ...row, distanceKm } : row,
                  ),
                }
              : it,
          ),
        }));
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setRouteError(e instanceof Error ? e.message : 'Erreur BRouter');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setRouteLoading(false);
      });

    return () => ctrl.abort();
  }, [map, isMapLoaded, startPoint, endPoint, viaPoints, profileId]);

  // Re-add the route after a Mapbox style.load (Standard Satellite wipes
  // custom layers). Mirrors the GPX layer logic in useItineraryPoiMap.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const onStyleLoad = () => {
      if (!startPoint || !endPoint) return;
      // Trigger a re-fetch by toggling a no-op state — simplest is to
      // call fetchBrouterRoute again here directly.
      fetchBrouterRoute({
        start: startPoint,
        end: endPoint,
        via: viaPoints,
        profile: panelProfileToBrouter(profileId),
      })
        .then((route) => {
          try {
            if (!isRouteOnMap(map)) {
              addRoute(map, route.coordinates, [
                { ...startPoint, kind: 'start' },
                { ...endPoint, kind: 'end' },
              ]);
            }
          } catch { /* noop */ }
        })
        .catch(() => { /* silent on style reload */ });
    };
    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded, startPoint, endPoint, viaPoints, profileId]);

  const panel = (
    <ItineraryPanel
      project={project}
      profiles={DEFAULT_PROFILES}
      width={width}
      isResizing={isResizing}
      onResizeStart={onResizeStart}
      onClose={onClose}
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
