import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useAppI18n } from '@/shared/i18n';
import {
  createOverlayStatus,
  type OverlayStatusReporter,
} from '@/features/map3d';

import { ItineraryPanel } from '../ItineraryPanel';
import { AddItineraryDialog } from '../dialogs';
import { useItineraryBrouterRouting } from '../../hooks/useItineraryBrouterRouting';
import { useItineraryFitRuntime } from '../../hooks/useItineraryFitRuntime';
import { useItinerary3dMarkers } from '../../hooks/useItinerary3dMarkers';
import { useItineraryPoiMap } from '../../hooks/useItineraryPoiMap';
import { useItineraryRouteLayerSync } from '../../hooks/useItineraryRouteLayerSync';
import { useItineraryWaypointDrag } from '../../hooks/useItineraryWaypointDrag';
import { FEATURE_TO_PANEL_POI, poiFeaturesToTimelineItems } from '../../lib/schedule';
import { useProjectStore } from '../../context/ProjectStore';
import { usePredictionStoreOptional } from '../../context/PredictionStore';
import {
  DEFAULT_PROFILES,
  normalizeItineraryRhythmState,
} from '../../lib/project';
import { resolveFavoritePoiPauseDurationMin } from '../../sections/timeline/TimelineTimelineView/utilsParts/schedule-stops';
import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import { POI_LABELS, type PoiFeature } from '@/features/poi/types';
import { deleteProjectItineraryFitFiles } from '@/shared/utils/projects';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
  refineImportedRoutePointsWithIgnAltimetry,
  simplifyPointsByQuality,
} from '../../lib/routes';
import type {
  Itinerary,
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
  TimelineView,
} from '../../types';
import { resolveImportedTimelineLabel } from './importedTimelineLabel';
import {
  buildPendingRoutePatchAfterRemoval,
  buildPendingRoutePatchForEditedRow,
  buildTimelineAfterRemoval,
  insertTimelineItem,
  moveTimelinePauseItem,
} from './timelineMutations';

interface ItineraryPanelContainerProps {
  projectId?: string | null;
  map: MapboxMap | null;
  isMapLoaded: boolean;
  onRouteStatusChange?: OverlayStatusReporter;
  width?: number;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
  isReturningToBrowser?: boolean;
  onBackToHome?: () => void;
}

export const ItineraryPanelContainer = memo(function ItineraryPanelContainer({
  projectId,
  map,
  isMapLoaded,
  onRouteStatusChange,
  width,
  onResizeStart,
  isResizing,
  isReturningToBrowser,
  onBackToHome,
}: ItineraryPanelContainerProps) {
  const {
    project,
    setProject,
    addItinerary,
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
  const { t } = useAppI18n();

  const active = useMemo(
    () => project.itineraries.find((i) => i.id === project.activeItineraryId) ?? null,
    [project],
  );
  const activeItineraryRef = useRef(active);
  activeItineraryRef.current = active;
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
    cancelCalculatePrediction,
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
    routeTraceWidthPx: project.controlPanel?.routes?.traceWidthPx ?? 4,
  });

  useItinerary3dMarkers(map, isMapLoaded, active);

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
    requestRouteRefresh,
    routeError,
    routeLoading,
    routeRequestNonce,
    routeWarnings,
  } = useItineraryBrouterRouting({
    active,
    isMapLoaded,
    map,
    rollbackPendingTraceAppend,
    setProject,
  });

  useEffect(() => {
    if (!onRouteStatusChange) return;

    if (routeLoading) {
      onRouteStatusChange(createOverlayStatus({
        id: 'itinerary',
        label: t('Itinéraire'),
        state: 'loading',
        progress: 0,
        detail: t('Calcul du tracé en cours'),
        nonce: routeRequestNonce,
        reloadable: false,
      }));
      return;
    }

    if (routeError) {
      onRouteStatusChange(createOverlayStatus({
        id: 'itinerary',
        label: 'Itinéraire',
        state: 'error',
        progress: 100,
        detail: routeError,
        reloadable: false,
      }));
      return;
    }

    onRouteStatusChange(null);
  }, [onRouteStatusChange, routeError, routeLoading, routeRequestNonce]);

  useEffect(() => {
    return () => {
      onRouteStatusChange?.(null);
    };
  }, [onRouteStatusChange]);

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

  const handleWaypointDragCommit = useCallback(
    (anchorId: string, lat: number, lon: number) => {
      updateActive((it) => {
        if (it.gpxRoute?.source !== 'brouter') return;
        const row = it.timeline.find((item) => item.id === anchorId);
        if (!row || (row.kind !== 'start' && row.kind !== 'waypoint' && row.kind !== 'end')) return;

        row.lat = lat;
        row.lon = lon;
        if (row.kind === 'start') row.distanceKm = 0;
        else if (row.kind === 'end') row.distanceKm = null;

        delete it.routeAudit;
        delete it.pendingTraceExtension;
        it.prediction = null;
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
      });
    },
    [updateActive],
  );

  useItineraryWaypointDrag({
    active,
    isMapLoaded,
    map,
    onCommitMove: handleWaypointDragCommit,
  });

  const activeIdRef = useRef(project.activeItineraryId);
  activeIdRef.current = project.activeItineraryId;

  const resolvePoiTitle = useCallback((feature: PoiFeature) => {
    return feature.name?.trim() || POI_LABELS[feature.category] || 'POI';
  }, []);

  const resolvePoiPopupState = useCallback((feature: PoiFeature) => {
    const itinerary = activeItineraryRef.current;
    if (!itinerary) {
      return {
        favoriteEnabled: Boolean(feature.favorite),
        pauseEnabled: false,
        pauseDurationMin: 5,
        manualTraceEnabled: false,
      };
    }

    const poiRow = itinerary.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
    const panelCategory = poiRow?.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
    const rhythm = normalizeItineraryRhythmState(itinerary.rhythm);
    const pauseDurationMin = panelCategory
      ? rhythm.poiPauseDurations[panelCategory] ?? 5
      : 5;
    const manualTraceWaypointId = `poi-waypoint-${feature.id}`;

    return {
      favoriteEnabled: Boolean(poiRow?.favorite ?? feature.favorite),
      pauseEnabled: Boolean(
        poiRow
        && poiRow.favorite
        && rhythm.pauseAtFavoritePois
        && pauseDurationMin > 0,
      ),
      pauseDurationMin,
      manualTraceEnabled: itinerary.timeline.some(
        (row) => row.id === manualTraceWaypointId,
      ),
    };
  }, []);

  const handlePoiFavoriteToggle = useCallback((feature: PoiFeature, nextEnabled: boolean) => {
    updateActive((it) => {
      const poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      if (poiRow) {
        poiRow.favorite = nextEnabled;
      }
      it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, feature.id, nextEnabled);
    });
  }, [updateActive]);

  const handlePoiStartHere = useCallback((feature: PoiFeature) => {
    updateActive((it) => {
      let row = it.timeline.find((item) => item.kind === 'start');
      if (!row) {
        insertTimelineItem(it.timeline, 'start');
        row = it.timeline.find((item) => item.kind === 'start');
      }
      if (!row) return;

      row.label = resolvePoiTitle(feature);
      row.lat = feature.lat;
      row.lon = feature.lon;
      row.distanceKm = 0;
      delete it.routeAudit;
      delete it.pendingTraceExtension;
      it.prediction = null;

      if (it.gpxRoute?.source === 'brouter') {
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
      }
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiFinishHere = useCallback((feature: PoiFeature) => {
    updateActive((it) => {
      let row = it.timeline.find((item) => item.kind === 'end');
      if (!row) {
        insertTimelineItem(it.timeline, 'end');
        row = it.timeline.find((item) => item.kind === 'end');
      }
      if (!row) return;

      row.label = resolvePoiTitle(feature);
      row.lat = feature.lat;
      row.lon = feature.lon;
      row.distanceKm = null;
      delete it.routeAudit;
      delete it.pendingTraceExtension;
      it.prediction = null;

      if (it.gpxRoute?.source === 'brouter') {
        it.pendingRoutePatch = buildPendingRoutePatchForEditedRow(it.timeline, row.id);
      }
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiPauseToggle = useCallback((
    feature: PoiFeature,
    nextEnabled: boolean,
    durationMin: number,
  ) => {
    updateActive((it) => {
      const poiRow = it.timeline.find((row) => row.kind === 'poi' && row.osmId === feature.id);
      if (!poiRow) return;

      const rhythm = normalizeItineraryRhythmState(it.rhythm);
      it.rhythm = rhythm;
      poiRow.favorite = nextEnabled;
      it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, feature.id, nextEnabled);

      if (!nextEnabled) {
        return;
      }

      rhythm.pauseAtFavoritePois = true;
      const panelCategory = poiRow.poiCategory ?? FEATURE_TO_PANEL_POI[feature.category];
      if (!panelCategory) return;

      const currentDuration = rhythm.poiPauseDurations[panelCategory];
      if (currentDuration == null || currentDuration <= 0) {
        rhythm.poiPauseDurations[panelCategory] = Math.max(1, Math.round(durationMin));
      }
    });
  }, [updateActive]);

  const handlePoiManualTraceToggle = useCallback((feature: PoiFeature, nextEnabled: boolean) => {
    updateActive((it) => {
      const waypointId = `poi-waypoint-${feature.id}`;
      const existingIndex = it.timeline.findIndex((row) => row.id === waypointId);

      if (nextEnabled) {
        if (existingIndex >= 0) return;

        const poiIndex = it.timeline.findIndex((row) => row.kind === 'poi' && row.osmId === feature.id);
        const endIndex = it.timeline.findIndex((row) => row.kind === 'end');
        const anchorRow = poiIndex >= 0 ? it.timeline[poiIndex] : null;
        const insertAt = poiIndex >= 0 ? poiIndex : endIndex >= 0 ? endIndex : it.timeline.length;

        it.timeline.splice(insertAt, 0, {
          id: waypointId,
          kind: 'waypoint',
          label: resolvePoiTitle(feature),
          distanceKm: anchorRow?.distanceKm ?? null,
          lat: feature.lat,
          lon: feature.lon,
          osmId: feature.id,
          visible: true,
        });
      } else {
        if (existingIndex < 0) return;
        it.timeline.splice(existingIndex, 1);
      }

      delete it.pendingRoutePatch;
      delete it.pendingTraceExtension;
      delete it.routeAudit;
      it.prediction = null;
    });
  }, [resolvePoiTitle, updateActive]);

  const handlePoiStreetView = useCallback((feature: PoiFeature) => {
    if (typeof window === 'undefined') return;
    const url = new URL('https://www.google.com/maps/@');
    url.searchParams.set('api', '1');
    url.searchParams.set('map_action', 'pano');
    url.searchParams.set('viewpoint', `${feature.lat},${feature.lon}`);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }, []);

  const handleCorridorUpdate = useCallback((features: PoiFeature[]) => {
    const targetId = activeIdRef.current;
    setProject((p) => {
      const target = p.itineraries.find((i) => i.id === targetId);
      if (!target) return p;
      const mergedFeatures = mergePoiFeatureFavorites(
        features,
        target.timeline,
        target.poiFeatures ?? [],
      );
      const current = target.poiFeatures ?? [];
      const unchanged =
        current.length === mergedFeatures.length
        && current.every((feature, index) => {
          const next = mergedFeatures[index];
          return (
            feature.id === next?.id
            && feature.lat === next.lat
            && feature.lon === next.lon
            && feature.category === next.category
            && feature.name === next.name
            && Boolean(feature.favorite) === Boolean(next.favorite)
          );
        });
      if (unchanged) return p;
      return {
        ...p,
        itineraries: p.itineraries.map((it) =>
          it.id === targetId ? { ...it, poiFeatures: mergedFeatures } : it,
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
      const mergedFeatures = mergePoiFeatureFavorites(
        features,
        target.timeline,
        target.poiFeatures ?? [],
      );

      const existingPoiRows = new Map(
        target.timeline
          .filter((row) => row.kind === 'poi' && row.osmId != null)
          .map((row) => [row.osmId as number, row]),
      );

      const newPoiRows = poiFeaturesToTimelineItems(mergedFeatures, route).map((row) => {
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
            ? { ...it, timeline: merged, poiFeatures: mergedFeatures }
            : it,
        ),
      };
    });
  }, [setProject]);

  const {
    cancelSearchCorridor,
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
    {
      getPopupState: resolvePoiPopupState,
      onStartHere: handlePoiStartHere,
      onFinishHere: handlePoiFinishHere,
      onToggleFavorite: handlePoiFavoriteToggle,
      onTogglePause: handlePoiPauseToggle,
      onToggleManualTrace: handlePoiManualTraceToggle,
      onOpenStreetView: handlePoiStreetView,
    },
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
      const ignAltimetryPoints = await refineImportedRoutePointsWithIgnAltimetry(route.points);
      const basePoints = ignAltimetryPoints ?? route.points;
      const storedPoints = normalizeImportedRoutePoints(basePoints, { includeGradient: false });
      const quality = 'default';
      const simplifiedPoints = normalizeImportedRoutePoints(
        simplifyPointsByQuality(storedPoints, quality),
      );
      const timeline = createImportedTimeline(simplifiedPoints);
      const id = addItinerary({
        name: route.name?.trim() || file.name.replace(/\.gpx$/i, ''),
        gpxRoute: {
          name: route.name,
          points: simplifiedPoints,
          originalPoints: storedPoints,
          gpxQuality: quality,
          gpxQualityPointsPerKm: null,
          source: 'gpx',
        },
        timeline,
        metrics: buildImportedRouteMetrics(simplifiedPoints),
      });

      if (id) {
        setPendingCorridorFor(id);
        void hydrateImportedTimelineEndpoints(id, simplifiedPoints);
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
    ? t('Importez un fichier GPX pour rechercher les POI le long du parcours.')
    : !hasEnabledCategories
      ? t('Activez au moins une catégorie ci-dessus.')
      : null;

  const panel = (
    <ItineraryPanel
      project={project}
      profiles={DEFAULT_PROFILES}
      width={width}
      isResizing={isResizing}
      onResizeStart={onResizeStart}
      isReturningToBrowser={isReturningToBrowser}
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
      onRefreshRoute={() => requestRouteRefresh()}
      onCancelRoute={() => cancelRouteRequest()}
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
      onCancelCalculate={() => {
        cancelCalculatePrediction();
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
      onCancelLoadPois={() => cancelSearchCorridor()}
      poiLoading={poiLoading}
      poiProgress={poiProgress}
      poiCount={poiCount}
      poiError={poiError}
      poiLoadDisabled={poiLoadDisabled}
      poiLoadDisabledReason={poiLoadDisabledReason}
      onChangeTimelineView={(view: TimelineView) =>
        setProject((p) => ({ ...p, timelineView: view }))
      }
      onAddTimelineItem={(kind, options) =>
        updateActive((it) => {
          insertTimelineItem(it.timeline, kind, options);
        })
      }
      onToggleTimelineItem={(id, visible) =>
        updateActive((it) => {
          const row = it.timeline.find((item) => item.id === id);
          if (row) row.visible = visible;
        })
      }
      onMoveTimelinePause={(id, distanceKm) =>
        updateActive((it) => {
          const moved = moveTimelinePauseItem(it.timeline, id, distanceKm);
          if (moved) return;
          it.rhythm = normalizeItineraryRhythmState(it.rhythm);
          if (id.startsWith('poi-pause-')) {
            delete it.rhythm.pausePositionOverridesKm[id];
            return;
          }
          it.rhythm.pausePositionOverridesKm[id] = Math.max(0, Number(distanceKm.toFixed(3)));
        })
      }
      onChangeTimelinePauseDuration={(id, durationMin) =>
        updateActive((it) => {
          const row = it.timeline.find((item) => item.id === id && item.kind === 'pause');
          if (!row) return;
          row.durationMin = Math.max(0, Math.round(durationMin));
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
          if (!row) return;

          const hasAutomaticFavoritePause =
            !favorite && resolveFavoritePoiPauseDurationMin(row, it.rhythm) > 0;
          if (hasAutomaticFavoritePause) return;

          row.favorite = favorite;
          if (row.kind === 'poi' && row.osmId != null) {
            it.poiFeatures = setPoiFeatureFavoriteState(it.poiFeatures, row.osmId, favorite);
          }
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
});

function setPoiFeatureFavoriteState(
  features: PoiFeature[] | undefined,
  poiId: number,
  favorite: boolean,
): PoiFeature[] | undefined {
  if (!features || features.length === 0) return features;

  let changed = false;
  const nextFeatures = features.map((feature) => {
    if (feature.id !== poiId) return feature;
    if (Boolean(feature.favorite) === favorite) return feature;
    changed = true;
    return { ...feature, favorite };
  });

  return changed ? nextFeatures : features;
}

function mergePoiFeatureFavorites(
  features: PoiFeature[],
  timeline: Itinerary['timeline'],
  currentFeatures: PoiFeature[],
): PoiFeature[] {
  if (features.length === 0) return features;

  const timelineFavorites = new Map<number, boolean>();
  for (const row of timeline) {
    if (row.kind === 'poi' && row.osmId != null) {
      timelineFavorites.set(row.osmId, Boolean(row.favorite));
    }
  }

  const currentFavorites = new Map<number, boolean>();
  for (const feature of currentFeatures) {
    if (feature.favorite != null) {
      currentFavorites.set(feature.id, feature.favorite);
    }
  }

  let changed = false;
  const merged = features.map((feature) => {
    const nextFavorite = timelineFavorites.get(feature.id)
      ?? currentFavorites.get(feature.id)
      ?? Boolean(feature.favorite);
    if (Boolean(feature.favorite) === nextFavorite) {
      return feature;
    }
    changed = true;
    return { ...feature, favorite: nextFavorite };
  });

  return changed ? merged : features;
}

export type { ItineraryPanelContainerProps };