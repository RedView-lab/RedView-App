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
import { useItineraryDeleteShortcut } from '../../hooks/useItineraryDeleteShortcut';
import { useItineraryFitRuntime } from '../../hooks/useItineraryFitRuntime';
import { useItineraryPoiMap } from '../../hooks/useItineraryPoiMap';
import { useItineraryRouteLayerSync } from '../../hooks/useItineraryRouteLayerSync';
import { useItineraryCheckpointMarkers } from '../../hooks/useItineraryCheckpointMarkers';
import { poiFeaturesToTimelineItems } from '../../lib/schedule';
import { useProjectStore } from '../../context/ProjectStore';
import { usePredictionStoreOptional } from '../../context/PredictionStore';
import { DEFAULT_PROFILES, getProfilePreset, resolveProfilePresetId } from '../../lib/project';
import type { PoiFeature } from '@/features/poi/types';
import { deleteProjectItineraryFitFiles } from '@/shared/utils/projects';
import type {
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
} from '../../types';
import { mergePoiFeatureFavorites } from './poiFeatureUtils';

import { useItineraryPoiHandlers } from './useItineraryPoiHandlers';
import { useItineraryMapActions } from './useItineraryMapActions';
import { useItineraryGpxImport } from './useItineraryGpxImport';
import { useItineraryTimelineCallbacks } from './useItineraryTimelineCallbacks';

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
  pausesEnabled?: boolean;
  waypointsEnabled?: boolean;
}

/**
 * Conteneur principal du panneau d'itinéraire (ItineraryPanel).
 * Orchestre le routage BRouter, l'import GPX, la synchronisation du tracé 3D, les POIs et le profil de performance.
 */
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
  pausesEnabled,
  waypointsEnabled,
}: ItineraryPanelContainerProps) {
  const {
    project,
    setProject,
    addItinerary,
    setItineraryName,
    duplicateItinerary,
    removeItinerary,
    setItineraryVisibility,
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
    routeTraceWidthPx: project.controlPanel?.routes?.traceWidthPx ?? 8,
    routesEnabled: project.controlPanel?.toggles?.routesEnabled ?? true,
  });


  useItineraryDeleteShortcut({
    activeItineraryId: active?.id ?? null,
    itineraryCount: itineraries.length,
    onRemove: removeItinerary,
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
        label: t('Itinéraire'),
        state: 'error',
        progress: 100,
        detail: routeError,
        reloadable: false,
      }));
      return;
    }

    onRouteStatusChange(null);
  }, [onRouteStatusChange, routeError, routeLoading, routeRequestNonce, t]);

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

  const activeIdRef = useRef(project.activeItineraryId);
  activeIdRef.current = project.activeItineraryId;

  const poiHandlers = useItineraryPoiHandlers({
    activeItineraryRef,
    updateActive,
    project,
    addItinerary,
  });

  useItineraryMapActions({
    updateActive,
    poiHandlers,
    project,
    addItinerary,
  });

  const { addItineraryFromGpxFile } = useItineraryGpxImport({
    setProject,
    addItinerary,
    setPendingCorridorFor,
  });

  const timelineCallbacks = useItineraryTimelineCallbacks({
    setProject,
    updateActive,
  });

  useItineraryCheckpointMarkers({
    itineraries,
    map,
    isMapLoaded,
    routesEnabled: project.controlPanel?.toggles?.routesEnabled ?? true,
    pausesEnabled,
    waypointsEnabled,
    onChangePauseDuration: timelineCallbacks.handleChangeTimelinePauseDuration,
    onDeletePause: timelineCallbacks.handleRemoveTimelineItem,
    onTogglePauseFavorite: timelineCallbacks.handleFavoriteTimelineItem,
    onDeleteWaypoint: timelineCallbacks.handleRemoveTimelineItem,
    onToggleWaypointFavorite: timelineCallbacks.handleFavoriteTimelineItem,
  });

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
      getPopupState: poiHandlers.resolvePoiPopupState,
      onStartHere: poiHandlers.handlePoiStartHere,
      onAddWaypoint: poiHandlers.handlePoiAddWaypoint,
      onFinishHere: poiHandlers.handlePoiFinishHere,
      onCyclePauseDuration: poiHandlers.handlePoiCyclePauseDuration,
      onSelectPauseDuration: poiHandlers.handlePoiSelectPauseDuration,
      onToggleFavorite: poiHandlers.handlePoiFavoriteToggle,
      onTogglePause: poiHandlers.handlePoiPauseToggle,
      onToggleManualTrace: poiHandlers.handlePoiManualTraceToggle,
      onOpenStreetView: poiHandlers.handlePoiStreetView,
      onDelete: poiHandlers.handlePoiDelete,
    },
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

  return (
    <>
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
        onDuplicateItinerary={duplicateItinerary}
        onRemoveItinerary={removeItinerary}
        onRenameItinerary={setItineraryName}
        onToggleItineraryVisibility={(id) => {
          const it = project.itineraries.find((i) => i.id === id);
          setItineraryVisibility(id, it ? it.visible === false : true);
        }}
        onChangeMode={(mode: PanelMode) =>
          setProject((p) => ({ ...p, activeMode: mode }))
        }
        onChangeProfile={(id) => {
          const preset = getProfilePreset(id);
          setProject((prev) => {
            const active = prev.itineraries.find((it) => it.id === prev.activeItineraryId);
            const applyToAll = active?.roadTypes.applyToAllItineraries;
            return {
              ...prev,
              itineraries: prev.itineraries.map((itinerary) => {
                if (itinerary.id !== prev.activeItineraryId && !applyToAll) return itinerary;
                const copy = structuredClone(itinerary);
                copy.profileId = id;
                if (preset) {
                  copy.priorities = { ...preset.priorities };
                  copy.roadTypes = {
                    ...preset.roadTypes,
                    applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
                  };
                }
                return copy;
              }),
            };
          });
        }}
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
            it.profileId = resolveProfilePresetId(it.priorities, it.roadTypes, it.profileId);
          })
        }
        onChangeRoadType={(key, value) =>
          setProject((prev) => {
            const active = prev.itineraries.find((it) => it.id === prev.activeItineraryId);
            const applyToAll =
              key === 'applyToAllItineraries' ? value : active?.roadTypes.applyToAllItineraries;
            return {
              ...prev,
              itineraries: prev.itineraries.map((itinerary) => {
                if (itinerary.id !== prev.activeItineraryId && !applyToAll) return itinerary;
                const copy = structuredClone(itinerary);
                (copy.roadTypes[key] as RoadTypesState[typeof key]) = value;
                if (key !== 'applyToAllItineraries') {
                  copy.profileId = resolveProfilePresetId(
                    copy.priorities,
                    copy.roadTypes,
                    copy.profileId,
                  );
                }
                return copy;
              }),
            };
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
        onChangeTimelineView={timelineCallbacks.handleChangeTimelineView}
        onAddTimelineItem={timelineCallbacks.handleAddTimelineItem}
        onToggleTimelineItem={timelineCallbacks.handleToggleTimelineItem}
        onMoveTimelinePause={timelineCallbacks.handleMoveTimelinePause}
        onChangeTimelinePauseDuration={timelineCallbacks.handleChangeTimelinePauseDuration}
        onRemoveTimelineItem={timelineCallbacks.handleRemoveTimelineItem}
        onFavoriteTimelineItem={timelineCallbacks.handleFavoriteTimelineItem}
        onSearchTimeline={() => {}}
        onOpenTimelineSettings={() => {}}
        onSelectTimelinePlace={timelineCallbacks.handleSelectTimelinePlace}
        routeLoading={routeLoading}
        routeError={routeError}
        routeWarnings={routeWarnings}
      />
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

export type { ItineraryPanelContainerProps };