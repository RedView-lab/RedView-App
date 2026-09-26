import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useAppI18n } from '@/shared/i18n';
import {
  createOverlayStatus,
  flyToLocation,
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
import { fitToRoute } from '../../lib/route-layer';
import { useProjectStore } from '../../context/ProjectStore';
import { useTraceToolOptional } from '@/features/centerPanel/tracer';
import { useForbiddenZoneToolOptional } from '@/features/centerPanel/forbiddenZones';
import { usePredictionStoreOptional } from '../../context/PredictionStore';
import { useItineraryUndoRedoShortcut } from '../../hooks/useItineraryUndoRedoShortcut';
import { DEFAULT_PROFILES, getProfilePreset, resolveProfilePresetId } from '../../lib/project';
import {
  syncTracageOnActivityChange,
  type ActivityType,
} from '../../lib/project/syncTracageParams';
import {
  getSavedCustomProfiles,
  saveCustomProfileToStorage,
  deleteCustomProfileFromStorage,
  CUSTOM_PROFILES_CHANGED_EVENT,
  type SavedCustomProfile,
} from '../../lib/project/customProfiles';
import type { PoiFeature } from '@/features/poi/types';
import {
  dispatchSelectPoiOnChart,
  listenOpenPoiOnMap,
} from '@/features/poi/lib/chartPoiSyncBridge';
import { deleteProjectItineraryFitFiles } from '@/shared/utils/projects';
import type {
  ItineraryProject,
  PanelMode,
  PrioritiesState,
  RhythmState,
  RoadTypesState,
  RouteProfile,
  TimelineItem,
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
  onRevealCenterPanel?: () => void;
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
  onRevealCenterPanel,
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
    commitTraceMutation,
    rollbackPendingTraceAppend,
  } = useProjectStore();
  const predictionStore = usePredictionStoreOptional();
  const traceTool = useTraceToolOptional();
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

  const forbiddenZoneTool = useForbiddenZoneToolOptional();
  const forbiddenZoneArmed = Boolean(forbiddenZoneTool?.armed);
  const canUndo = forbiddenZoneArmed ? (forbiddenZoneTool?.canUndoDraft ?? false) : canUndoTraceEdit;
  const canRedo = forbiddenZoneArmed ? (forbiddenZoneTool?.canRedoDraft ?? false) : canRedoTraceEdit;
  const handleUndo = useCallback(() => {
    if (forbiddenZoneArmed) {
      forbiddenZoneTool?.undoDraft();
    } else {
      undoTraceEdit();
    }
  }, [forbiddenZoneArmed, forbiddenZoneTool, undoTraceEdit]);
  const handleRedo = useCallback(() => {
    if (forbiddenZoneArmed) {
      forbiddenZoneTool?.redoDraft();
    } else {
      redoTraceEdit();
    }
  }, [forbiddenZoneArmed, forbiddenZoneTool, redoTraceEdit]);

  useItineraryUndoRedoShortcut({
    canUndo,
    canRedo,
    onUndo: handleUndo,
    onRedo: handleRedo,
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

  /**
   * Variante de `updateActive` qui enregistre la mutation dans l'historique
   * undo/redo : utilisée pour les suppressions (POI, waypoints, étapes) afin
   * qu'elles soient annulables avec les flèches Précédent / Rétablir.
   */
  const updateActiveWithHistory = useCallback(
    (
      mutateItinerary: (
        itinerary: ItineraryProject['itineraries'][number],
      ) => boolean | void,
    ) => {
      const targetId = activeIdRef.current;
      return commitTraceMutation(targetId, (draft) => {
        const target = draft.itineraries.find((itinerary) => itinerary.id === targetId);
        if (!target) return false;
        return mutateItinerary(target);
      });
    },
    [commitTraceMutation],
  );

  const poiHandlers = useItineraryPoiHandlers({
    activeItineraryRef,
    updateActive,
    updateActiveWithHistory,
    project,
    addItinerary,
  });

  useItineraryMapActions({
    updateActive,
    updateActiveWithHistory,
    poiHandlers,
    project,
    addItinerary,
  });

  // GPX import progress, surfaced as a loading row in the itinerary list.
  const [pendingImportName, setPendingImportName] = useState<string | null>(null);
  const gpxInputRef = useRef<HTMLInputElement | null>(null);

  const fitMapToImportedRoute = useCallback(
    (points: [number, number][]) => {
      if (!map || points.length === 0) return;
      try {
        const leftPadding = Math.max(80, (width ?? 360) + 40);
        fitToRoute(map, points, {
          padding: {
            top: 80,
            bottom: Math.min(270, Math.round(window.innerHeight * 0.35)),
            left: Math.min(leftPadding, Math.round(window.innerWidth * 0.4)),
            right: 80,
          },
          maxZoom: 14,
          duration: 800,
        });
      } catch (error) {
        console.warn('[ItineraryPanelContainer] fitToRoute after GPX import failed', error);
      }
    },
    [map, width],
  );

  const { addItineraryFromGpxFile } = useItineraryGpxImport({
    setProject,
    addItinerary,
    setPendingCorridorFor,
    onImportStateChange: setPendingImportName,
    onItineraryImported: (_id, points) => {
      fitMapToImportedRoute(points);
      onRevealCenterPanel?.();
    },
  });

  const handleGpxFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.gpx')) {
        console.warn('[ItineraryPanelContainer] Selected file is not a .gpx');
        return;
      }
      try {
        await addItineraryFromGpxFile(file);
      } catch (err) {
        console.warn('[ItineraryPanelContainer] GPX import failed', err);
      }
    },
    [addItineraryFromGpxFile],
  );

  const handlePickGpx = useCallback(() => {
    setAddDialogOpen(false);
    gpxInputRef.current?.click();
  }, []);

  const timelineCallbacks = useItineraryTimelineCallbacks({
    setProject,
    updateActive,
    updateActiveWithHistory,
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
            favorite: Boolean(previous.favorite || row.favorite),
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

  const [selectedTimelineIds, setSelectedTimelineIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedTimelineIds([]);
  }, [project.activeItineraryId]);

  const centerTimelineRowInList = useCallback((itemId: string) => {
    window.requestAnimationFrame(() => {
      const rowEl = document.querySelector<HTMLElement>(`[data-timeline-id="${itemId}"]`);
      if (!rowEl) return;

      let container: HTMLElement | null = rowEl.parentElement;
      while (container) {
        const style = window.getComputedStyle(container);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && container.scrollHeight > container.clientHeight) {
          break;
        }
        container = container.parentElement;
      }

      if (container) {
        const rowRect = rowEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const targetScrollTop =
          container.scrollTop +
          (rowRect.top - containerRect.top) -
          (container.clientHeight / 2) +
          (rowRect.height / 2);

        container.scrollTo({
          top: Math.max(0, targetScrollTop),
          behavior: 'smooth',
        });
      } else {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, []);

  const handleMapPoiSelect = useCallback(
    (feature: PoiFeature) => {
      const currentActive = activeItineraryRef.current;
      if (!currentActive) return;

      const matchingItem = currentActive.timeline.find((item) => {
        if (item.kind === 'poi' && item.osmId != null && item.osmId === feature.id) return true;
        if (item.id === `poi-${feature.id}`) return true;
        if (item.lat != null && item.lon != null) {
          return Math.abs(item.lat - feature.lat) < 0.0001 && Math.abs(item.lon - feature.lon) < 0.0001;
        }
        return false;
      });

      if (matchingItem) {
        setSelectedTimelineIds([matchingItem.id]);
        centerTimelineRowInList(matchingItem.id);
      }

      dispatchSelectPoiOnChart({
        id: feature.id,
        osmId: feature.id,
        lat: feature.lat,
        lon: feature.lon,
        distanceKm: matchingItem?.distanceKm,
        category: feature.category,
        itineraryId: currentActive.id,
        source: 'map',
      });
    },
    [centerTimelineRowInList],
  );

  const {
    cancelSearchCorridor,
    loading: poiLoading,
    error: poiError,
    poiCount,
    corridorProgress: poiProgress,
    searchCorridor,
    hasGpxRoute,
    hasEnabledCategories,
    openPoiMarker,
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
      onSelectPoi: handleMapPoiSelect,
    },
  );

  const handleSelectTimelineRow = useCallback(
    (id: string, item: TimelineItem) => {
      setSelectedTimelineIds([id]);
      if (item.kind === 'poi') {
        const opened = openPoiMarker(
          item.osmId ?? item.id,
          item.poiCategory,
          item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : undefined,
        );
        if (!opened && map && item.lat != null && item.lon != null) {
          flyToLocation(map, { lon: item.lon, lat: item.lat }, { zoom: 15.5 });
        }
      } else if (map && item.lat != null && item.lon != null) {
        flyToLocation(map, { lon: item.lon, lat: item.lat }, { zoom: 15.5 });
      }

      dispatchSelectPoiOnChart({
        id: item.id,
        osmId: item.osmId,
        lat: item.lat,
        lon: item.lon,
        distanceKm: item.distanceKm,
        category: item.poiCategory,
        itineraryId: activeItineraryRef.current?.id,
        source: 'timeline',
      });
    },
    [map, openPoiMarker],
  );

  useEffect(() => {
    return listenOpenPoiOnMap((payload) => {
      const currentActive = activeItineraryRef.current;
      if (!currentActive) return;

      const matchingItem = currentActive.timeline.find((item) => {
        if (
          payload.id &&
          (item.id === payload.id ||
            item.id === `poi-${payload.id}` ||
            String(item.osmId) === String(payload.id))
        ) {
          return true;
        }
        if (payload.osmId != null && item.osmId === payload.osmId) return true;
        if (payload.lat != null && payload.lon != null && item.lat != null && item.lon != null) {
          return Math.abs(item.lat - payload.lat) < 0.0001 && Math.abs(item.lon - payload.lon) < 0.0001;
        }
        return false;
      });

      if (matchingItem) {
        setSelectedTimelineIds([matchingItem.id]);
        centerTimelineRowInList(matchingItem.id);
        openPoiMarker(
          matchingItem.osmId ?? matchingItem.id,
          matchingItem.poiCategory,
          matchingItem.lat != null && matchingItem.lon != null
            ? { lat: matchingItem.lat, lon: matchingItem.lon }
            : undefined,
        );
      } else if (payload.lat != null && payload.lon != null) {
        openPoiMarker(
          payload.id ?? '',
          payload.category,
          { lat: payload.lat, lon: payload.lon },
        );
      }
    });
  }, [centerTimelineRowInList, openPoiMarker]);

  const duplicateActiveItinerary = useCallback(() => {
    duplicateItinerary(project.activeItineraryId);
  }, [duplicateItinerary, project.activeItineraryId]);

  /**
   * Création d'un itinéraire vierge (« Créer un nouvel itinéraire »).
   *
   * On arme Tracer dans la foulée : l'utilisateur enchaîne directement sur le
   * tracé au clic sur la carte, sans avoir à cliquer le bouton. L'armement ne
   * passe pas par le garde `canTrace` de `toggle()` — le store vient d'être muté
   * et les deux mises à jour sont batchées, donc le rendu suivant est cohérent.
   */
  const handleCreateBlankItinerary = useCallback(() => {
    addItinerary();
    traceTool?.activate();
  }, [addItinerary, traceTool]);

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

  const [savedCustomProfiles, setSavedCustomProfiles] = useState<SavedCustomProfile[]>(() =>
    getSavedCustomProfiles(),
  );

  useEffect(() => {
    const handler = () => setSavedCustomProfiles(getSavedCustomProfiles());
    window.addEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CUSTOM_PROFILES_CHANGED_EVENT, handler);
  }, []);

  const combinedProfiles = useMemo<RouteProfile[]>(() => {
    const customItems: RouteProfile[] = savedCustomProfiles.map((cp) => ({
      id: cp.id,
      name: cp.name,
    }));
    return [...DEFAULT_PROFILES, ...customItems];
  }, [savedCustomProfiles]);

  return (
    <>
      <ItineraryPanel
        project={project}
        profiles={combinedProfiles}
        width={width}
        isResizing={isResizing}
        onResizeStart={onResizeStart}
        isReturningToBrowser={isReturningToBrowser}
        onBackToHome={onBackToHome}
        onShareProject={() => { }}
        onRenameProject={(next) => setProject((p) => ({ ...p, name: next }))}
        onSelectItinerary={(id) =>
          setProject((p) => ({
            ...p,
            activeItineraryId: id,
            itineraries: p.itineraries.map((it) =>
              it.id === id ? { ...it, visible: true, analysisVisible: true } : it,
            ),
          }))
        }
        onAddItinerary={handleCreateBlankItinerary}
        onAddButtonRef={(element) => {
          addButtonRef.current = element;
        }}
        onOpenAddItinerary={() => setAddDialogOpen((open) => !open)}
        onAddItineraryFromGpx={addItineraryFromGpxFile}
        pendingImportName={pendingImportName}
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
          const custom = savedCustomProfiles.find((p) => p.id === id);
          if (custom) {
            setProject((prev) => {
              const active = prev.itineraries.find((it) => it.id === prev.activeItineraryId);
              const applyToAll = active?.roadTypes.applyToAllItineraries;
              return {
                ...prev,
                itineraries: prev.itineraries.map((itinerary) => {
                  if (itinerary.id !== prev.activeItineraryId && !applyToAll) return itinerary;
                  const copy = structuredClone(itinerary);
                  copy.profileId = id;
                  copy.priorities = { ...custom.priorities };
                  copy.roadTypes = {
                    ...custom.roadTypes,
                    applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
                  };
                  return copy;
                }),
              };
            });
            return;
          }
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
                  const currentMode = copy.roadTypes.tracingMode ?? 'vitesse';
                  const currentTolerance = copy.roadTypes.surfaceTolerance ?? 10;
                  const isActivityType = id === 'road' || id === 'gravel-default' || id === 'mtb';
                  if (isActivityType) {
                    const sync = syncTracageOnActivityChange(id as ActivityType, currentMode, currentTolerance);
                    if (sync.priorities) {
                      copy.priorities = { ...copy.priorities, ...sync.priorities };
                    }
                    copy.roadTypes = {
                      ...copy.roadTypes,
                      ...sync.roadTypes,
                      applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
                    };
                  } else {
                    copy.priorities = { ...preset.priorities };
                    copy.roadTypes = {
                      ...preset.roadTypes,
                      tracingMode: currentMode,
                      applyToAllItineraries: copy.roadTypes.applyToAllItineraries,
                    };
                  }
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
        onSaveProfile={(profile) => {
          if (profile) {
            saveCustomProfileToStorage(profile);
            setSavedCustomProfiles(getSavedCustomProfiles());
          }
        }}
        onDeleteProfile={(id) => {
          deleteCustomProfileFromStorage(id);
          setSavedCustomProfiles(getSavedCustomProfiles());
        }}
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
                if (key === 'activityType') {
                  copy.profileId = value as string;
                }
                return copy;
              }),
            };
          })
        }
        onBatchChangeRoadTypes={(roadUpdates, priorityUpdates) =>
          setProject((prev) => {
            const active = prev.itineraries.find((it) => it.id === prev.activeItineraryId);
            const applyToAll =
              roadUpdates.applyToAllItineraries !== undefined
                ? roadUpdates.applyToAllItineraries
                : active?.roadTypes.applyToAllItineraries;
            return {
              ...prev,
              itineraries: prev.itineraries.map((itinerary) => {
                if (itinerary.id !== prev.activeItineraryId && !applyToAll) return itinerary;
                const copy = structuredClone(itinerary);
                Object.assign(copy.roadTypes, roadUpdates);
                if (priorityUpdates) {
                  Object.assign(copy.priorities, priorityUpdates);
                }
                if (roadUpdates.activityType) {
                  copy.profileId = roadUpdates.activityType;
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
        onOpenPoiCategories={() => { }}
        onLoadPois={() => searchCorridor()}
        onCancelLoadPois={() => cancelSearchCorridor()}
        poiLoading={poiLoading}
        poiProgress={poiProgress}
        poiCount={poiCount}
        poiError={poiError}
        poiLoadDisabled={poiLoadDisabled}
        poiLoadDisabledReason={poiLoadDisabledReason}
        selectedTimelineIds={selectedTimelineIds}
        onSelectTimelineRow={handleSelectTimelineRow}
        onSelectionTimelineChange={setSelectedTimelineIds}
        onChangeTimelineView={timelineCallbacks.handleChangeTimelineView}
        onAddTimelineItem={timelineCallbacks.handleAddTimelineItem}
        onToggleTimelineItem={timelineCallbacks.handleToggleTimelineItem}
        onMoveTimelinePause={timelineCallbacks.handleMoveTimelinePause}
        onChangeTimelinePauseDuration={timelineCallbacks.handleChangeTimelinePauseDuration}
        onRemoveTimelineItem={timelineCallbacks.handleRemoveTimelineItem}
        onFavoriteTimelineItem={timelineCallbacks.handleFavoriteTimelineItem}
        onSearchTimeline={() => { }}
        onOpenTimelineSettings={() => { }}
        onSelectTimelinePlace={timelineCallbacks.handleSelectTimelinePlace}
        routeLoading={routeLoading}
        routeError={routeError}
        routeWarnings={routeWarnings}
      />
      <AddItineraryDialog
        open={addDialogOpen}
        anchorEl={addButtonRef.current}
        onClose={() => setAddDialogOpen(false)}
        onPickScratch={handleCreateBlankItinerary}
        onPickDuplicate={active ? duplicateActiveItinerary : undefined}
        onPickGpx={handlePickGpx}
      />
      <input
        ref={gpxInputRef}
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        hidden
        onChange={handleGpxFileChange}
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