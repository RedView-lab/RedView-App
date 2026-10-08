import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useAppI18n } from '@/shared/i18n';
import { normalizeDiscipline } from '@/shared/lib/discipline';
import type { OverlayStatusReporter } from '@/features/map3d';

import { ItineraryPanel } from '../ItineraryPanel';
import { AddItineraryDialog } from '../dialogs';
import { useItineraryBrouterRouting } from '../../hooks/useItineraryBrouterRouting';
import { useItineraryDeleteShortcut } from '../../hooks/useItineraryDeleteShortcut';
import { useItineraryFitRuntime } from '../../hooks/useItineraryFitRuntime';
import { useItineraryPoiMap } from '../../hooks/useItineraryPoiMap';
import { useItineraryRouteLayerSync } from '../../hooks/useItineraryRouteLayerSync';
import { useItineraryCheckpointMarkers } from '../../hooks/useItineraryCheckpointMarkers';
import {
  buildPoiAutoSortSignature,
  buildPoiSearchSignature,
} from '../../lib/schedule';
import { useProjectStore } from '../../context/ProjectStore';
import { cloneItineraryForMutation } from '../../context/ProjectStore/historyClone';
import { useTraceToolOptional } from '@/features/centerPanel/tools/tracer';
import { useForbiddenZoneToolOptional } from '@/features/centerPanel/tools/forbiddenZones';
import { usePredictionStoreOptional } from '../../context/PredictionStore';
import { useItineraryUndoRedoShortcut } from '../../hooks/useItineraryUndoRedoShortcut';
import { useRouteDistanceLabels } from '../../hooks/useRouteDistanceLabels';
import { resolveProfilePresetId } from '../../lib/project';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '../../lib/route-layer/constants';
import type { TimelineFilterState } from '../../sections/timeline/TimelineFilters';
import type { GpxRoute, PoiFeature } from '@/features/poi/types';
import { dispatchSelectPoiOnChart } from '@/features/poi/lib/chartPoiSyncBridge';
import type { CollaboratorAction, Itinerary, ItineraryProject, PanelMode, PrioritiesState, RhythmState, ProjectCollaborator, ProjectSessionStatus } from '../../types';

import { useItineraryPoiHandlers } from './useItineraryPoiHandlers';
import { useItineraryMapActions } from './useItineraryMapActions';
import { useItineraryTimelineCallbacks } from './useItineraryTimelineCallbacks';
import { useRecalculateTrace } from './useRecalculateTrace';
import { useGpxFilePicker } from './useGpxFilePicker';
import { usePendingFitDeletions } from './usePendingFitDeletions';
import { useTimelineMapSelection } from './useTimelineMapSelection';
import { useProjectSave } from './useProjectSave';
import { useCustomProfiles } from './useCustomProfiles';
import { useRouteOverlayStatus } from './useRouteOverlayStatus';
import { usePoiRouteInvalidation } from './usePoiRouteInvalidation';
import { applyCorridorComplete, applyCorridorUpdate } from './poiCorridorMutations';
import {
  applyBatchRoadTypeChange,
  applyProfileChange,
  applyRoadTypeChange,
} from './routingPreferenceMutations';
import { centerTimelineRowInList, findTimelineItemForPoiFeature } from './timelineRowLookup';

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
  onSaveProject?: (options?: { force?: boolean }) => Promise<ItineraryProject | null>;
  /** « Partager » (co-édition) ; absent pour un projet local. */
  onShareProject?: (anchor: HTMLElement) => void;
  collaborators?: ProjectCollaborator[];
  /** Clic sur une pastille d'éditeur (le suivre, présenter sa vue). */
  onCollaboratorAction?: (userId: string, action: CollaboratorAction) => void;
  sessionStatus?: ProjectSessionStatus;
  pausesEnabled?: boolean;
  waypointsEnabled?: boolean;
  poisRouteEnabled?: boolean;
  favorisEnabled?: boolean;
  selectedPoiCategories?: Set<string>;
  globalFilters?: TimelineFilterState;
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
  onSaveProject,
  onShareProject,
  collaborators,
  onCollaboratorAction,
  sessionStatus,
  pausesEnabled,
  waypointsEnabled,
  poisRouteEnabled,
  favorisEnabled,
  selectedPoiCategories,
  globalFilters,
  onRevealCenterPanel,
}: ItineraryPanelContainerProps) {
  const {
    project,
    setProject,
    setProjectWithoutHistory,
    addItinerary,
    setItineraryName,
    duplicateItinerary,
    removeItinerary,
    setItineraryVisibility,
    undoTraceEdit,
    redoTraceEdit,
    canUndoTraceEdit,
    canRedoTraceEdit,
    historyRevision,
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

  const {
    calculateDisabled,
    calculateError,
    calculateLabel,
    cancelCalculatePrediction,
    fitFileNames,
    fitNotice,
    fitInputRef,
    handleCalculatePrediction,
    handleClearFitFiles,
    handleFitInputChange,
    handleRemoveFitFile,
    handleUploadFitRequest,
  } = useItineraryFitRuntime({
    active,
    projectId: projectId ?? null,
    predictionStore,
    setProject: setProjectWithoutHistory,
  });

  useItineraryRouteLayerSync({
    active,
    isMapLoaded,
    itineraries,
    map,
    routeTraceWidthPx: project.controlPanel?.routes?.traceWidthPx ?? DEFAULT_ROUTE_TRACE_WIDTH_PX,
    routeDisplayQuality: project.controlPanel?.routes?.quality ?? 'auto',
    routesEnabled: project.controlPanel?.toggles?.routesEnabled ?? true,
    surfaceFilter: project.analysis?.surfaceFilter ?? 'all',
    // Chip « Pente » du graphe central : l'itinéraire actif passe en mode pente
    // sur la carte, comme son profil.
    slopeItineraryId: project.analysis?.filters?.slopeColors ? (active?.id ?? null) : null,
  });
  // Même chip : bornes kilométriques (25 / 50 km) sur la trace en pente.
  useRouteDistanceLabels({
    map,
    isMapLoaded,
    itinerary: project.analysis?.filters?.slopeColors ? active : null,
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

  usePendingFitDeletions(projectId, itineraries);

  const {
    cancelRouteRequest,
    requestRouteRefresh,
    routeError,
    routeLoading,
    routeRequestNonce,
    routeWarnings,
    skipNextRouteRecompute,
  } = useItineraryBrouterRouting({
    active,
    itineraries,
    historyRevision,
    isMapLoaded,
    map,
    rollbackPendingTraceAppend,
    setProject: setProjectWithoutHistory,
  });

  const {
    recalculateLoading,
    recalculateProgress,
    showRecalculateTrace,
    handleRecalculateTrace,
  } = useRecalculateTrace({
    active,
    commitTraceMutation,
    historyRevision,
    cancelRouteRequest,
    skipNextRouteRecompute,
  });


  useRouteOverlayStatus({ onRouteStatusChange, routeLoading, routeError, routeRequestNonce });


  const updateActive = useCallback(
    (mutateItinerary: (itinerary: ItineraryProject['itineraries'][number]) => void) => {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((itinerary) => {
          if (itinerary.id !== prev.activeItineraryId) return itinerary;
          const copy = cloneItineraryForMutation(itinerary);
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

  const [selectedTimelineIds, setSelectedTimelineIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedTimelineIds([]);
  }, [project.activeItineraryId]);

  const handleSelectAndCenterTimelineRow = useCallback(
    (rowId: string) => {
      setSelectedTimelineIds([rowId]);
      centerTimelineRowInList(rowId);
    },
    [],
  );

  const getPrediction = useCallback(
    (itinerary: Itinerary) => predictionStore?.predictions[itinerary.id] ?? itinerary.prediction ?? null,
    [predictionStore],
  );

  const poiHandlers = useItineraryPoiHandlers({
    activeItineraryRef,
    updateActive,
    updateActiveWithHistory,
    project,
    addItinerary,
    onSelectAndCenterTimelineRow: handleSelectAndCenterTimelineRow,
    getPrediction,
  });

  // POI chargés avec d'autres réglages que ceux affichés → « Relancer la recherche ».
  const poiFoundCount = active?.poiFeatures?.length ?? 0;
  const poiSearchStale = Boolean(
    poiFoundCount > 0
    && active?.poiSearchSignature != null
    && active.poiSearchSignature !== buildPoiSearchSignature(active.poi),
  );
  // Recherche, départ ou rythme modifiés depuis le dernier tri → « Re-trier ».
  const activePrediction = active ? getPrediction(active) : null;
  const poiAutoSortSignature = useMemo(
    () => (active ? buildPoiAutoSortSignature(active, activePrediction) : null),
    [active, activePrediction],
  );
  const poiAutoSortView = useMemo(() => {
    if (!active?.poiAutoSort) return null;
    return {
      summary: active.poiAutoSort.summary,
      // Sans `picks` : tri d'avant le filtrage (favoris auto), à refaire.
      stale: active.poiAutoSort.signature !== poiAutoSortSignature || !active.poiAutoSort.picks,
    };
  }, [active?.poiAutoSort, poiAutoSortSignature]);
  const poiAutoSortEnabled = Boolean(active?.poiAutoSortEnabled);
  const poiAutoSortDisabled = !active?.gpxRoute?.points?.length || poiFoundCount === 0;

  useItineraryMapActions({
    updateActive,
    updateActiveWithHistory,
    poiHandlers,
    project,
    addItinerary,
    onSelectAndCenterTimelineRow: handleSelectAndCenterTimelineRow,
  });

  const {
    gpxInputRef,
    pendingImportName,
    addItineraryFromGpxFile,
    handleGpxFileChange,
    openGpxPicker,
  } = useGpxFilePicker({
    map,
    panelWidth: width,
    setProjectWithoutHistory,
    addItinerary,
    setPendingCorridorFor,
    onRevealCenterPanel,
  });

  const handlePickGpx = useCallback(() => {
    setAddDialogOpen(false);
    openGpxPicker();
  }, [openGpxPicker]);

  const timelineCallbacks = useItineraryTimelineCallbacks({
    setProject,
    updateActive,
    updateActiveWithHistory,
    onSelectAndCenterTimelineRow: handleSelectAndCenterTimelineRow,
  });

  const { openCheckpointMarker } = useItineraryCheckpointMarkers({
    itineraries,
    map,
    isMapLoaded,
    routesEnabled: project.controlPanel?.toggles?.routesEnabled ?? true,
    pausesEnabled,
    waypointsEnabled,
    poisRouteEnabled,
    favorisEnabled,
    selectedPoiCategories,
    onChangePauseDuration: timelineCallbacks.handleChangeTimelinePauseDuration,
    onDeletePause: timelineCallbacks.handleRemoveTimelineItem,
    onTogglePauseFavorite: timelineCallbacks.handleFavoriteTimelineItem,
    onDeleteWaypoint: timelineCallbacks.handleRemoveTimelineItem,
    onToggleWaypointFavorite: timelineCallbacks.handleFavoriteTimelineItem,
  });

  // Résultats de la recherche POI (async) : hors historique.
  const handleCorridorUpdate = useCallback((features: PoiFeature[]) => {
    const targetId = activeIdRef.current;
    setProjectWithoutHistory((p) => applyCorridorUpdate(p, targetId, features));
  }, [setProjectWithoutHistory]);

  const handleCorridorComplete = useCallback((features: PoiFeature[], searchedRoutePoints: GpxRoute['points']) => {
    const targetId = activeIdRef.current;
    setProjectWithoutHistory((p) => applyCorridorComplete(p, targetId, features, searchedRoutePoints));
  }, [setProjectWithoutHistory]);

  const handleMapPoiSelect = useCallback(
    (feature: PoiFeature) => {
      const currentActive = activeItineraryRef.current;
      if (!currentActive) return;

      const matchingItem = findTimelineItemForPoiFeature(currentActive.timeline, feature);

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
    [],
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
      onOpenStreetView: poiHandlers.handlePoiStreetView,
      onDelete: poiHandlers.handlePoiDelete,
      onSelectPoi: handleMapPoiSelect,
    },
    poisRouteEnabled,
    favorisEnabled,
    selectedPoiCategories,
  );

  const { handleSelectTimelineRow } = useTimelineMapSelection({
    map,
    activeItineraryRef,
    setSelectedTimelineIds,
    openPoiMarker,
    openCheckpointMarker,
  });

  const duplicateActiveItinerary = useCallback(() => {
    trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'duplicate' } });
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
    trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'blank' } });
    trackAnalyticsEvent({ name: 'map_tool_selected', data: { tool: 'tracer' } });
    traceTool?.activate();
  }, [addItinerary, traceTool]);

  usePoiRouteInvalidation({
    active,
    isMapLoaded,
    historyRevision,
    routeBusy: routeLoading || recalculateLoading,
    pendingCorridorFor,
    setPendingCorridorFor,
    setProjectWithoutHistory,
    poiLoading,
    hasGpxRoute,
    hasEnabledCategories,
    searchCorridor,
    cancelSearchCorridor,
  });

  // Toggle « Affiner les résultats » actif : re-trie dès que les entrées du
  // dernier tri changent (POI rechargés, départ, prédiction…). Clé sur la
  // signature courante : un tri impossible n'est pas relancé en boucle.
  const { refreshPoiAutoSort } = poiHandlers;
  const poiAutoSortNeedsRun = poiAutoSortEnabled
    && !poiAutoSortDisabled
    && !poiLoading
    && (poiAutoSortView == null || poiAutoSortView.stale);
  useEffect(() => {
    if (poiAutoSortNeedsRun) refreshPoiAutoSort();
  }, [poiAutoSortNeedsRun, poiAutoSortSignature, refreshPoiAutoSort]);

  const poiLoadDisabled = !hasGpxRoute || !hasEnabledCategories;
  // Sans catégorie cochée le bouton est simplement grisé : pas de message.
  const poiLoadDisabledReason = !hasGpxRoute
    ? t('Importez un fichier GPX pour rechercher les POI le long du parcours.')
    : null;

  const { savedCustomProfiles, combinedProfiles, saveCustomProfile, deleteCustomProfile } =
    useCustomProfiles(project.routingProfiles);

  const { handleSaveProject, displayedSaveStatus, displayedSaveMessage } = useProjectSave({
    projectId,
    onSaveProject,
    setProject,
  });


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
        onSaveProject={onSaveProject ? () => { void handleSaveProject(); } : undefined}
        saveStatus={displayedSaveStatus}
        saveStatusMessage={displayedSaveMessage ?? undefined}
        onShareProject={onShareProject}
        collaborators={collaborators}
        onCollaboratorAction={onCollaboratorAction}
        sessionStatus={sessionStatus}
        onRenameProject={(next) => setProject((p) => ({ ...p, name: next }))}
        // La sélection ne touche pas à la visibilité (œil indépendant).
        onSelectItinerary={(id) => setProject((p) => ({ ...p, activeItineraryId: id }))}
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
        onChangeProfile={(id) => setProject((prev) => applyProfileChange(prev, id, savedCustomProfiles))}
        onChangeDiscipline={(discipline) => {
          const current = project.itineraries.find(
            (it) => it.id === project.activeItineraryId,
          );
          if (!current || normalizeDiscipline(current.discipline) === discipline) return;
          // Un autre moteur produit la prédiction : abandonner l'ancienne et laisser
          // le runtime fit la recalculer quand le rythme était déjà réglé.
          const shouldRecompute = current.rhythmConfigured === true || current.prediction != null;
          updateActive((it) => {
            it.discipline = discipline;
            it.prediction = undefined;
            if (it.metrics) it.metrics.durationSec = undefined;
            if (shouldRecompute) it.pendingFitRecompute = true;
          });
          predictionStore?.setPrediction(current.id, null);
        }}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onSaveProfile={saveCustomProfile}
        onDeleteProfile={deleteCustomProfile}
        onChangePriority={(key: keyof PrioritiesState, value) =>
          updateActive((it) => {
            it.priorities[key] = value;
            it.profileId = resolveProfilePresetId(it.priorities, it.roadTypes, it.profileId);
          })
        }
        onChangeRoadType={(key, value) => setProject((prev) => applyRoadTypeChange(prev, key, value))}
        onBatchChangeRoadTypes={(roadUpdates, priorityUpdates) =>
          setProject((prev) => applyBatchRoadTypeChange(prev, roadUpdates, priorityUpdates))
        }
        onRefreshRoute={() => requestRouteRefresh()}
        onCancelRoute={() => cancelRouteRequest()}
        onRecalculateTrace={handleRecalculateTrace}
        recalculateLoading={recalculateLoading}
        recalculateProgress={recalculateProgress}
        showRecalculateTrace={showRecalculateTrace}
        onChangeRhythm={(key, value) =>
          updateActive((it) => {
            (it.rhythm[key] as RhythmState[typeof key]) = value;
            it.rhythmConfigured = true;
          })
        }
        onUploadFit={() => {
          handleUploadFitRequest();
        }}
        fitFileNames={fitFileNames}
        onRemoveFitFile={handleRemoveFitFile}
        onClearFitFiles={handleClearFitFiles}
        onCalculate={() => {
          handleCalculatePrediction();
        }}
        onCancelCalculate={() => {
          cancelCalculatePrediction();
        }}
        calculateLabel={calculateLabel}
        calculateDisabled={calculateDisabled}
        calculateError={calculateError}
        fitNotice={fitNotice}
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
        poiCount={poiFoundCount || poiCount}
        poiError={poiError}
        poiLoadDisabled={poiLoadDisabled}
        poiLoadDisabledReason={poiLoadDisabledReason}
        poiSearchStale={poiSearchStale}
        poiAutoSortEnabled={poiAutoSortEnabled}
        onTogglePoiAutoSort={poiHandlers.handleTogglePoiAutoSort}
        poiAutoSortDisabled={poiAutoSortDisabled || poiLoading}
        poiAutoSort={poiAutoSortView}
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
        globalFilters={globalFilters}
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
