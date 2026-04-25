import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { ItineraryPanel } from './ItineraryPanel';
import { AddItineraryDialog } from './components/AddItineraryDialog';
import { useItineraryBrouterRouting } from './hooks/useItineraryBrouterRouting';
import { useItineraryFitRuntime } from './hooks/useItineraryFitRuntime';
import { useItineraryPoiMap } from './hooks/useItineraryPoiMap';
import { useItineraryRouteLayerSync } from './hooks/useItineraryRouteLayerSync';
import { poiFeaturesToTimelineItems } from './lib/poi-to-timeline';
import { useProjectStore } from './context/ProjectStore';
import { usePredictionStoreOptional } from './context/PredictionStore';
import {
  createDefaultItinerary,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from './defaultState';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import type { PoiFeature } from '@/features/poi/types';
import {
  formatGpsCoordinateLabel,
  reverseGeocodeSettlement,
} from './lib/geocoder';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
} from './lib/imported-route';
import type {
  Itinerary,
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
  TimelineItem,
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
  const {
    project,
    setProject,
    setItineraryName,
    duplicateItinerary,
    removeItinerary,
    undoTraceEdit,
    redoTraceEdit,
    canUndoTraceEdit,
    canRedoTraceEdit,
    rollbackPendingTraceAppend,
  } = useProjectStore();
  const predictionStore = usePredictionStoreOptional();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  const [pendingCorridorFor, setPendingCorridorFor] = useState<string | null>(
    null,
  );

  const active = useMemo(
    () =>
      project.itineraries.find((i) => i.id === project.activeItineraryId) ??
      null,
    [project],
  );
  const itineraries = project.itineraries;

  const {
    calculateDisabled,
    calculateLabel,
    fitInputRef,
    handleCalculatePrediction,
    handleFitInputChange,
    handleUploadFitRequest,
    uploadFitLabel,
  } = useItineraryFitRuntime({
    active,
    predictionStore,
    setProject,
  });

  useItineraryRouteLayerSync({
    active,
    isMapLoaded,
    itineraries,
    map,
  });

  const {
    routeError,
    routeLoading,
    routeWarnings,
  } = useItineraryBrouterRouting({
    active,
    isMapLoaded,
    map,
    rollbackPendingTraceAppend,
    setProject,
  });

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

  const handleCorridorUpdate = useCallback((features: PoiFeature[]) => {
    const targetId = activeIdRef.current;
    setProject((p) => {
      const target = p.itineraries.find((i) => i.id === targetId);
      if (!target) return p;
      const current = target.poiFeatures ?? [];
      const unchanged =
        current.length === features.length
        && current.every((feature, index) => {
          const next = features[index];
          return (
            feature.id === next?.id
            && feature.lat === next.lat
            && feature.lon === next.lon
            && feature.category === next.category
            && feature.name === next.name
          );
        });
      if (unchanged) return p;
      return {
        ...p,
        itineraries: p.itineraries.map((it) =>
          it.id === targetId ? { ...it, poiFeatures: features } : it,
        ),
      };
    });
  }, []);

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
          it.id === targetId
            ? { ...it, timeline: merged, poiFeatures: features }
            : it,
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
  } = useItineraryPoiMap(
    map,
    isMapLoaded,
    active,
    handleCorridorUpdate,
    handleCorridorComplete,
  );

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

  const hydrateImportedTimelineEndpoints = useCallback(
    async (
      itineraryId: string,
      points: NonNullable<Itinerary['gpxRoute']>['points'],
    ) => {
      const startPoint = points[0];
      const endPoint = points[points.length - 1] ?? startPoint;
      if (!startPoint) return;

      const [startLabel, endLabel] = await Promise.all([
        resolveImportedTimelineLabel(startPoint.lon, startPoint.lat),
        resolveImportedTimelineLabel(endPoint.lon, endPoint.lat),
      ]);

      setProject((project) => ({
        ...project,
        itineraries: project.itineraries.map((itinerary) => {
          if (itinerary.id !== itineraryId) return itinerary;
          return {
            ...itinerary,
            timeline: itinerary.timeline.map((item) => {
              if (item.kind === 'start') {
                return {
                  ...item,
                  label: startLabel,
                  lat: startPoint.lat,
                  lon: startPoint.lon,
                };
              }
              if (item.kind === 'end') {
                return {
                  ...item,
                  label: endLabel,
                  lat: endPoint.lat,
                  lon: endPoint.lon,
                };
              }
              return item;
            }),
          };
        }),
      }));
    },
    [setProject],
  );

  const addItineraryFromGpxFile = useCallback(
    async (file: File) => {
      const route = await parseGpxFile(file);
      const storedPoints = normalizeImportedRoutePoints(route.points);
      const timeline = createImportedTimeline(storedPoints);
      const id = addItinerary({
        name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
        gpxRoute: { name: route.name, points: storedPoints, source: 'gpx' },
        timeline,
        metrics: buildImportedRouteMetrics(storedPoints),
      });

      if (id) {
        setPendingCorridorFor(id);
        void hydrateImportedTimelineEndpoints(id, storedPoints);
      }
    },
    [addItinerary, hydrateImportedTimelineEndpoints],
  );

  const duplicateActiveItinerary = useCallback(() => {
    duplicateItinerary(project.activeItineraryId);
  }, [duplicateItinerary, project.activeItineraryId]);

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
      onAddButtonRef={(element) => {
        addButtonRef.current = element;
      }}
      onOpenAddItinerary={() => setAddDialogOpen((open) => !open)}
      onAddItineraryFromGpx={addItineraryFromGpxFile}
      onRemoveItinerary={removeItinerary}
      onRenameItinerary={setItineraryName}
      onChangeMode={(mode: PanelMode) =>
        setProject((p) => ({ ...p, activeMode: mode }))
      }
      onChangeProfile={(id) =>
        updateActive((it) => {
          it.profileId = id;
        })
      }
      onUndo={undoTraceEdit}
      onRedo={redoTraceEdit}
      canUndo={canUndoTraceEdit}
      canRedo={canRedoTraceEdit}
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
        handleUploadFitRequest();
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
          const removedIndex = it.timeline.findIndex((item) => item.id === id);
          const removedRow = removedIndex >= 0 ? it.timeline[removedIndex] : null;
          it.timeline = it.timeline.filter(
            (i) => i.id !== id || i.kind === 'start' || i.kind === 'end',
          );
          if (it.gpxRoute?.source === 'brouter') {
            it.pendingRoutePatch = buildPendingRoutePatchAfterRemoval(
              it.timeline,
              removedIndex,
              removedRow,
            );
            delete it.pendingTraceExtension;
            delete it.routeAudit;
            it.prediction = null;
          }
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
          if (it.gpxRoute?.source === 'brouter') {
            it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, id);
            delete it.pendingTraceExtension;
            delete it.routeAudit;
            it.prediction = null;
          }
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
        anchorEl={addButtonRef.current}
        onClose={() => setAddDialogOpen(false)}
        onPickScratch={() => addItinerary()}
        onPickDuplicate={duplicateActiveItinerary}
        onPickGpx={addItineraryFromGpxFile}
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

async function resolveImportedTimelineLabel(
  lon: number,
  lat: number,
): Promise<string> {
  try {
    const settlement = await reverseGeocodeSettlement(lon, lat, {
      maxDistanceMeters: 1000,
    });
    return settlement?.name?.trim() || formatGpsCoordinateLabel(lon, lat);
  } catch {
    return formatGpsCoordinateLabel(lon, lat);
  }
}

function isRoutableTimelineRow(
  row: TimelineItem | null | undefined,
): row is TimelineItem & { lat: number; lon: number } {
  return Boolean(
    row &&
    (row.kind === 'start' || row.kind === 'waypoint' || row.kind === 'end') &&
    row.lat != null &&
    row.lon != null,
  );
}

function buildPendingRoutePatchForEditedRow(
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
      end: { lat: next.lat, lon: next.lon, kind: next.kind === 'end' ? 'end' : 'waypoint' },
      via: [],
    };
  }

  if (focus.kind === 'end') {
    const previous = routableRows[focusIndex - 1];
    if (!previous) return undefined;
    return {
      start: { lat: previous.lat, lon: previous.lon, kind: previous.kind === 'start' ? 'start' : 'waypoint' },
      end: { lat: focus.lat, lon: focus.lon, kind: 'end' },
      via: [],
    };
  }

  const previous = routableRows[focusIndex - 1];
  const next = routableRows[focusIndex + 1];
  if (!previous || !next) return undefined;
  return {
    start: { lat: previous.lat, lon: previous.lon, kind: previous.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: next.lat, lon: next.lon, kind: next.kind === 'end' ? 'end' : 'waypoint' },
    via: [{ lat: focus.lat, lon: focus.lon }],
  };
}

function buildPendingRoutePatchAfterRemoval(
  timeline: TimelineItem[],
  removedIndex: number,
  removedRow: TimelineItem | null,
): Itinerary['pendingRoutePatch'] {
  if (!isRoutableTimelineRow(removedRow) || removedRow.kind === 'start' || removedRow.kind === 'end') {
    return undefined;
  }

  const before = [...timeline]
    .slice(0, Math.max(0, removedIndex))
    .reverse()
    .find(isRoutableTimelineRow);
  const after = timeline
    .slice(Math.max(0, removedIndex))
    .find(isRoutableTimelineRow);
  if (!before || !after) return undefined;

  return {
    start: { lat: before.lat, lon: before.lon, kind: before.kind === 'start' ? 'start' : 'waypoint' },
    end: { lat: after.lat, lon: after.lon, kind: after.kind === 'end' ? 'end' : 'waypoint' },
    via: [],
  };
}
