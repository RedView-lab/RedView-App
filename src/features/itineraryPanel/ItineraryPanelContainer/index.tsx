import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { ItineraryPanel } from '../ItineraryPanel';
import { AddItineraryDialog } from '../components/AddItineraryDialog';
import { useItineraryBrouterRouting } from '../hooks/useItineraryBrouterRouting';
import { useItineraryFitRuntime } from '../hooks/useItineraryFitRuntime';
import { useItineraryPoiMap } from '../hooks/useItineraryPoiMap';
import { useItineraryRouteLayerSync } from '../hooks/useItineraryRouteLayerSync';
import { poiFeaturesToTimelineItems } from '../lib/poi-to-timeline';
import { useProjectStore } from '../context/ProjectStore';
import { usePredictionStoreOptional } from '../context/PredictionStore';
import {
  createDefaultItinerary,
  DEFAULT_PROFILES,
  ITINERARY_COLORS,
} from '../defaultState';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import type { PoiFeature } from '@/features/poi/types';
import { deleteProjectItineraryFitFiles } from '@/lib/projects';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
} from '../lib/imported-route';
import type {
  Itinerary,
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
  TimelineView,
} from '../types';
import { resolveImportedTimelineLabel } from './importedTimelineLabel';
import {
  buildPendingRoutePatchAfterRemoval,
  buildPendingRoutePatchForEditedRow,
  buildTimelineAfterRemoval,
  insertTimelineItem,
} from './timelineMutations';

interface ItineraryPanelContainerProps {
  projectId?: string | null;
  map: MapboxMap | null;
  isMapLoaded: boolean;
  width?: number;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
  onBackToHome?: () => void;
}

export function ItineraryPanelContainer({
  projectId,
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
  const [pendingCorridorFor, setPendingCorridorFor] = useState<string | null>(null);

  const active = useMemo(
    () => project.itineraries.find((i) => i.id === project.activeItineraryId) ?? null,
    [project],
  );
  const itineraries = project.itineraries;
  const itineraryIdsSignature = useMemo(
    () => itineraries.map((itinerary) => itinerary.id).join('|'),
    [itineraries],
  );
  const previousItineraryIdsRef = useRef<string[]>(
    itineraries.map((itinerary) => itinerary.id),
  );

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
    projectId: projectId ?? null,
    predictionStore,
    setProject,
  });

  useItineraryRouteLayerSync({
    active,
    isMapLoaded,
    itineraries,
    map,
  });

  useEffect(() => {
    const previousIds = previousItineraryIdsRef.current;
    const currentIds = itineraries.map((itinerary) => itinerary.id);
    previousItineraryIdsRef.current = currentIds;
    if (!projectId) return;

    const removedIds = previousIds.filter((id) => !currentIds.includes(id));
    for (const removedId of removedIds) {
      void deleteProjectItineraryFitFiles(projectId, removedId).catch((error) => {
        console.warn('[fit-predictor] failed to delete itinerary FIT files', error);
      });
    }
  }, [itineraries, itineraryIdsSignature, projectId]);

  const {
    cancelRouteRequest,
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
  }, [setProject]);

  const handleCorridorComplete = useCallback((features: PoiFeature[]) => {
    const targetId = activeIdRef.current;
    setProject((p) => {
      const target = p.itineraries.find((i) => i.id === targetId);
      if (!target) return p;
      const route = target.gpxRoute?.points;
      if (!route || route.length < 2) return p;

      const existingPoiRows = new Map(
        target.timeline
          .filter((row) => row.kind === 'poi' && row.osmId != null)
          .map((row) => [row.osmId as number, row]),
      );

      const newPoiRows = poiFeaturesToTimelineItems(features, route).map((row) => {
        const previous = row.osmId != null ? existingPoiRows.get(row.osmId) : undefined;
        return previous
          ? {
              ...row,
              favorite: previous.favorite,
              visible: previous.visible ?? row.visible,
            }
          : row;
      });

      const stripped = target.timeline.filter((row) => row.kind !== 'poi');
      const endIdx = stripped.findIndex((row) => row.kind === 'end');
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
  }, [setProject]);

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
    (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((itinerary) => {
          if (itinerary.id !== prev.activeItineraryId) return itinerary;
          const copy = structuredClone(itinerary);
          mutateItinerary(copy);
          return copy;
        }),
      }));
    },
    [setProject],
  );

  const addItinerary = useCallback(
    (overrides: Partial<ReturnType<typeof createDefaultItinerary>> = {}) => {
      let createdId: string | null = null;
      setProject((p) => {
        const idx = p.itineraries.length;
        const color = ITINERARY_COLORS[idx % ITINERARY_COLORS.length] ?? ITINERARY_COLORS[0];
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
    [setProject],
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

      setProject((projectState) => ({
        ...projectState,
        itineraries: projectState.itineraries.map((itinerary) => {
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

  useEffect(() => {
    if (!pendingCorridorFor) return;
    if (!active || active.id !== pendingCorridorFor) return;
    if (!hasGpxRoute || !hasEnabledCategories || !isMapLoaded) return;
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
      onUndo={() => {
        cancelRouteRequest();
        undoTraceEdit();
      }}
      onRedo={() => {
        cancelRouteRequest();
        redoTraceEdit();
      }}
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
      onChangePoiRefineLimit={(value) =>
        updateActive((it) => {
          it.poi.refineLimitPerKm = value;
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
      onAddTimelineItem={(kind) =>
        updateActive((it) => {
          insertTimelineItem(it.timeline, kind);
        })
      }
      onToggleTimelineItem={(id, visible) =>
        updateActive((it) => {
          const row = it.timeline.find((item) => item.id === id);
          if (row) row.visible = visible;
        })
      }
      onRemoveTimelineItem={(id) =>
        updateActive((it) => {
          const removedIndex = it.timeline.findIndex((item) => item.id === id);
          const removedRow = removedIndex >= 0 ? it.timeline[removedIndex] : null;
          const nextTimeline = buildTimelineAfterRemoval(it.timeline, id);
          if (!nextTimeline) return;

          it.timeline = nextTimeline;
          if (it.gpxRoute?.source === 'brouter') {
            it.pendingRoutePatch = buildPendingRoutePatchAfterRemoval(
              nextTimeline,
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
          const row = it.timeline.find((item) => item.id === id);
          if (row) row.favorite = favorite;
        })
      }
      onSearchTimeline={() => {}}
      onOpenTimelineSettings={() => {}}
      onSelectTimelinePlace={(id, place) =>
        updateActive((it) => {
          const row = it.timeline.find((item) => item.id === id);
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

export type { ItineraryPanelContainerProps };