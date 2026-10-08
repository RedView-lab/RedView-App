import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
  MapContextMenuOverlayContext,
} from '@/features/map3d';

import { applyLidarViewerRouteEdit, useProjectStoreOptional } from '@/features/itineraryPanel';
import { syncLidarRouteOverlay, useLidarRouteSync, type LidarRouteOverlayItem } from '@/features/lidar';
import { ControlPanel } from './ControlPanel';
import { diffControlPanelForAnalytics } from '../lib/controlPanelAnalytics';
import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { buildBasemapList, normalizeBasemapId } from '../lib/basemaps';
import { DEFAULT_CONTROL_PANEL_STATE } from '../lib/defaultState';
import {
  createDefaultControlPanelPersistedState,
  type ControlPanelPersistedState,
  type ControlPanelSectionKey,
} from '../lib/persistedState';
import type { BasemapId, ControlPanelState } from '../types';
import { useControlPanelOverlayState } from '../hooks/useControlPanelOverlayState';
import { useControlPanelTerrainState } from '../hooks/useControlPanelTerrainState';
import { useControlPanelLidarTiles } from '../hooks/container/useControlPanelLidarTiles';
import { useControlPanelRoutes } from '../hooks/container/useControlPanelRoutes';
import { publishDem3dSelection } from '@/features/map3d/lib/publishDem3dSelection';
import {
  normalizeMapEnvironment,
  setActiveMapEnvironment,
} from '@/features/map3d/lib/mapEnvironment';

export interface ControlPanelContainerProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  onBasemapChange?: (id: BasemapId) => void;
  onWeatherOverlayStatusChange?: OverlayStatusReporter;
  onWeatherOverlayReloadChange?: OverlayReloadRegistrar;
  onWindOverlayStatusChange?: OverlayStatusReporter;
  onWindOverlayReloadChange?: OverlayReloadRegistrar;
  onShadowOverlayStatusChange?: OverlayStatusReporter;
  onShadowOverlayReloadChange?: OverlayReloadRegistrar;
  onSunlightMapOverlayStatusChange?: OverlayStatusReporter;
  onSunlightMapOverlayReloadChange?: OverlayReloadRegistrar;
  onSlopeOverlayStatusChange?: OverlayStatusReporter;
  onAltitudeOverlayStatusChange?: OverlayStatusReporter;
  onToggleLidarDownloadMode?: () => void;
  onCancelLidarSelection?: () => void;
  lidarDownloadModeActive?: boolean;
  width?: number | '100%';
  onResizeStart?: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
  onContextMenuOverlayContextChange?: (context: MapContextMenuOverlayContext) => void;
}

/**
 * Conteneur principal du Control Panel.
 * Orchestre les états de basemap, LiDAR, itinéraires, relief (terrain) et calques météo/ensoleillement.
 */
export const ControlPanelContainer = memo(function ControlPanelContainer({
  map,
  isMapLoaded,
  onBasemapChange,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
  onWindOverlayStatusChange,
  onWindOverlayReloadChange,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onSunlightMapOverlayStatusChange,
  onSunlightMapOverlayReloadChange,
  onSlopeOverlayStatusChange,
  onAltitudeOverlayStatusChange,
  onToggleLidarDownloadMode,
  onCancelLidarSelection,
  lidarDownloadModeActive,
  width,
  onResizeStart,
  isResizing,
  onContextMenuOverlayContextChange,
}: ControlPanelContainerProps) {
  const projectStore = useProjectStoreOptional();
  const setProject = projectStore?.setProject;
  // Réglages du projet à l'ouverture : chaque sous-état s'en initialise une
  // fois, puis vit sa vie (les changements repartent par updateProjectControlPanel).
  const [initialControlPanel] = useState(
    () => projectStore?.project.controlPanel ?? createDefaultControlPanelPersistedState(),
  );

  const updateProjectControlPanel = useCallback(
    (mut: (draft: ControlPanelPersistedState) => void) => {
      if (!setProject) return;
      queueMicrotask(() => {
        setProject((prev) => {
          const controlPanel = structuredClone(
            prev.controlPanel ?? createDefaultControlPanelPersistedState(),
          );
          mut(controlPanel);
          // Mesure d'audience : couches basculées, fond de carte changé.
          for (const event of diffControlPanelForAnalytics(prev.controlPanel, controlPanel)) trackAnalyticsEvent(event);
          return { ...prev, controlPanel };
        });
      });
    },
    [setProject],
  );

  const [activeBasemapId, setActiveBasemapId] = useState<BasemapId>(
    () => normalizeBasemapId(initialControlPanel.basemapId),
  );

  const itineraries = projectStore?.project.itineraries;

  // Une trace créée dans le visualiseur LiDAR devient un simple itinéraire GPX.
  const addLidarRouteItinerary = useCallback(
    (route: LidarRouteOverlayItem) => {
      trackAnalyticsEvent({ name: 'itinerary_added', data: { method: 'lidar' } });
      projectStore?.addItinerary({
        id: route.id,
        name: route.name,
        color: route.color,
        opacity: Math.round(route.opacity * 100),
        visible: route.visible,
        gpxRoute: {
          name: route.name,
          source: 'gpx',
          points: route.points.map((pt, idx: number) => ({
            lat: pt.lat,
            lon: pt.lon,
            elevationM: pt.elevationM ?? null,
            distanceM: pt.distanceM ?? idx * 10,
          })),
        },
      });
    },
    [projectStore],
  );

  useLidarRouteSync({
    itineraries,
    onLidarRouteEdit: useCallback(
      (
        routeId: string,
        points: Array<{ lat: number; lon: number; elevationM?: number | null; distanceM?: number }>,
        actionName?: string,
      ) => {
        if (!projectStore) return;
        // Tracé routé : le geste du viewer (éditeur à main levée, segments
        // droits) devient l'édition équivalente de l'app, routée — jamais de
        // ligne droite stockée (cf. applyLidarViewerRouteEdit).
        const itinerary = projectStore.project.itineraries.find((it) => it.id === routeId);
        if (itinerary?.gpxRoute?.source === 'brouter' && (actionName === 'undo' || actionName === 'redo')) {
          // L'historique du viewer garde ses états à main levée : celui de l'app fait foi.
          if (actionName === 'undo') projectStore.undoTraceEdit();
          else projectStore.redoTraceEdit();
          syncLidarRouteOverlay(projectStore.project.itineraries);
          return;
        }
        const outcome = itinerary
          ? applyLidarViewerRouteEdit(structuredClone(itinerary), points, actionName)
          : 'raw';
        if (outcome === 'applied') {
          projectStore.updateItinerary(routeId, (draft) => {
            applyLidarViewerRouteEdit(draft, points, actionName);
          });
          // Le recalcul local est celui de l'itinéraire actif.
          projectStore.setProject((project) => (
            project.activeItineraryId === routeId ? project : { ...project, activeItineraryId: routeId }
          ));
          return;
        }
        if (outcome === 'ignored') {
          // Le viewer revient au tracé stocké.
          syncLidarRouteOverlay(projectStore.project.itineraries);
          return;
        }
        projectStore.updateItineraryRoutePoints(routeId, points, {
          source: 'lidar_viewer',
          actionName,
        });
      },
      [projectStore],
    ),
    onLidarRouteCreate: addLidarRouteItinerary,
    onLidarRouteDuplicate: useCallback(
      (sourceRouteId: string, route: LidarRouteOverlayItem) => {
        // Même id / nom / couleur que la copie du visualiseur ; profil, frise…
        // viennent du doublon propre au projet.
        const duplicated = projectStore?.duplicateItinerary(sourceRouteId, {
          id: route.id,
          name: route.name,
          color: route.color,
          visible: route.visible,
        });
        // Une trace que le projet ne connaît pas (dessinée dans un visualiseur
        // sans l'application ouverte) est ajoutée comme simple copie.
        if (!duplicated && !projectStore?.project.itineraries.some((it) => it.id === route.id)) {
          addLidarRouteItinerary(route);
        }
      },
      [projectStore, addLidarRouteItinerary],
    ),
    onLidarRouteRename: useCallback(
      (routeId: string, name: string) => {
        projectStore?.setItineraryName(routeId, name);
      },
      [projectStore],
    ),
    onLidarRouteDelete: useCallback(
      (routeId: string) => {
        projectStore?.removeItinerary(routeId);
      },
      [projectStore],
    ),
  });

  const {
    lidarTiles,
    lidarDownloadProgress,
    lidarDownloadError,
    handlers: lidarHandlers,
  } = useControlPanelLidarTiles({
    initialControlPanel,
    updateProjectControlPanel,
    onToggleLidarDownloadMode,
    onCancelLidarSelection,
    itineraries,
  });

  const { routesSlice, handlers: routeHandlers } = useControlPanelRoutes({
    updateProjectControlPanel,
  });

  const terrainState = useControlPanelTerrainState({
    map,
    isMapLoaded,
    activeBasemapId,
    initialControlPanel,
    updateProjectControlPanel,
    analysisZone: null,
    onSlopeOverlayStatusChange,
    onAltitudeOverlayStatusChange,
  });

  const overlayState = useControlPanelOverlayState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    analysisZone: null,
    onWeatherOverlayStatusChange,
    onWeatherOverlayReloadChange,
    onWindOverlayStatusChange,
    onWindOverlayReloadChange,
    onShadowOverlayStatusChange,
    onShadowOverlayReloadChange,
    onSunlightMapOverlayStatusChange,
    onSunlightMapOverlayReloadChange,
  });

  const projectControlPanel =
    projectStore?.project.controlPanel ?? createDefaultControlPanelPersistedState();

  const handleSectionOpenChange = useCallback(
    (section: ControlPanelSectionKey, open: boolean) => {
      updateProjectControlPanel((draft) => {
        draft.sectionsOpen[section] = open;
      });
    },
    [updateProjectControlPanel],
  );

  const handleBasemapToggle = useCallback(
    (id: BasemapId) => {
      const nextBasemapId = normalizeBasemapId(id);
      if (nextBasemapId === activeBasemapId) return;

      setActiveBasemapId(nextBasemapId);
      updateProjectControlPanel((draft) => {
        draft.basemapId = nextBasemapId;
      });
      onBasemapChange?.(nextBasemapId);
    },
    [activeBasemapId, onBasemapChange, updateProjectControlPanel],
  );

  const state: ControlPanelState = useMemo(
    () => ({
      ...DEFAULT_CONTROL_PANEL_STATE,
      basemaps: buildBasemapList(activeBasemapId),
      basemap3dQuality: {
        ...DEFAULT_CONTROL_PANEL_STATE.basemap3dQuality,
        value:
          projectControlPanel.basemap3dQuality
          ?? DEFAULT_CONTROL_PANEL_STATE.basemap3dQuality.value,
      },
      mapEnvironment: {
        ...DEFAULT_CONTROL_PANEL_STATE.mapEnvironment,
        value: normalizeMapEnvironment(projectControlPanel.mapEnvironment),
      },
      lidarTiles,
      contourLines: terrainState.slices.contourLines,
      routes: routesSlice,
      labels: overlayState.slices.labels,
      slopes: terrainState.slices.slopes,
      altitude: terrainState.slices.altitude,
      weather: overlayState.slices.weather,
      wind: overlayState.slices.wind,
      snow: overlayState.slices.snow,
      sunlight: overlayState.slices.sunlight,
    }),
    [
      activeBasemapId,
      lidarTiles,
      overlayState.slices.labels,
      overlayState.slices.snow,
      overlayState.slices.sunlight,
      overlayState.slices.weather,
      overlayState.slices.wind,
      projectControlPanel.basemap3dQuality,
      projectControlPanel.mapEnvironment,
      routesSlice,
      terrainState.slices.contourLines,
      terrainState.slices.altitude,
      terrainState.slices.slopes,
    ],
  );

  const applyDem3dSelection = useCallback((value: string | null | undefined) => {
    publishDem3dSelection(value);
  }, []);

  const lastEmittedOverlayContextRef = useRef<string | null>(null);
  useEffect(() => {
    const nextContext: MapContextMenuOverlayContext = {
      weather: {
        enabled: overlayState.slices.weather.enabled,
        date: overlayState.slices.weather.date,
        time: overlayState.slices.weather.time,
        forecastDay: overlayState.slices.weather.forecastDay,
        activeLayers: overlayState.slices.weather.layers
          .filter((layer) => layer.enabled)
          .map((layer) => layer.key)
          .filter((key): key is MapContextMenuOverlayContext['weather']['activeLayers'][number] => (
            key === 'temperature'
            || key === 'feelsLike'
            || key === 'rain'
            || key === 'cloudCover'
            || key === 'humidity'
          )),
      },
      wind: {
        enabled: overlayState.slices.wind.enabled,
        date: overlayState.slices.wind.date,
        time: overlayState.slices.wind.time,
        forecastDay: overlayState.slices.wind.forecastDay,
        terrainOverlayEnabled: overlayState.slices.wind.terrainOverlayEnabled,
        particlesEnabled: overlayState.slices.wind.particlesEnabled,
      },
      sunlight: {
        enabled: overlayState.slices.sunlight.enabled,
        date: overlayState.slices.sunlight.date,
        time: overlayState.slices.sunlight.time,
        shadowEnabled: overlayState.slices.sunlight.shadowEnabled,
        sunlightMapEnabled: overlayState.slices.sunlight.sunlightMapEnabled,
      },
    };

    const serialized = JSON.stringify(nextContext);
    if (serialized === lastEmittedOverlayContextRef.current) return;
    lastEmittedOverlayContextRef.current = serialized;
    onContextMenuOverlayContextChange?.(nextContext);
  }, [onContextMenuOverlayContextChange, overlayState.slices.sunlight, overlayState.slices.weather, overlayState.slices.wind]);

  useEffect(() => {
    applyDem3dSelection(projectControlPanel.basemap3dQuality);
  }, [applyDem3dSelection, projectControlPanel.basemap3dQuality]);

  useEffect(() => {
    setActiveMapEnvironment(projectControlPanel.mapEnvironment);
  }, [projectControlPanel.mapEnvironment]);

  return (
    <ControlPanel
      state={state}
      lidarDownloadProgress={lidarDownloadProgress}
      lidarDownloadError={lidarDownloadError}
      lidarDownloadModeActive={lidarDownloadModeActive}
      className={lidarDownloadModeActive ? 'rvc-panel--lidar-selecting' : undefined}
      sectionsOpen={projectControlPanel.sectionsOpen}
      onSectionOpenChange={handleSectionOpenChange}
      onAltitudeEnabledChange={terrainState.handlers.onAltitudeEnabledChange}
      onAltitudeColorizationChange={terrainState.handlers.onAltitudeColorizationChange}
      onAltitudeScaleSettingChange={terrainState.handlers.onAltitudeScaleSettingChange}
      onAltitudeOpacityChange={terrainState.handlers.onAltitudeOpacityChange}
      onAltitudeBandColorChange={terrainState.handlers.onAltitudeBandColorChange}
      onAltitudeBandVisibilityToggle={terrainState.handlers.onAltitudeBandVisibilityToggle}
      onAltitudeBandBreakpointChange={terrainState.handlers.onAltitudeBandBreakpointChange}
      sunlightMapExpanded={projectControlPanel.sunlightMapExpanded}
      onSunlightMapExpandedChange={(open) => {
        updateProjectControlPanel((draft) => {
          draft.sunlightMapExpanded = open;
        });
      }}
      width={width}
      onResizeStart={onResizeStart}
      isResizing={isResizing}
      onBasemapToggle={handleBasemapToggle}
      onLidarTileToggle={lidarHandlers.onLidarTileToggle}
      onLidarTileOpen={lidarHandlers.onLidarTileOpen}
      onLidarTileDelete={lidarHandlers.onLidarTileDelete}
      onLidarTileRename={lidarHandlers.onLidarTileRename}
      onLidarTileDownload={lidarHandlers.onLidarTileDownload}
      onLidarSelectionCancel={lidarHandlers.onLidarSelectionCancel}
      onLidarDownloadCancel={lidarHandlers.onLidarDownloadCancel}
      onLabelsEnabledChange={overlayState.handlers.onLabelsEnabledChange}
      onLabelToggle={overlayState.handlers.onLabelToggle}
      onContourLinesEnabledChange={terrainState.handlers.onContourLinesEnabledChange}
      onContourLinesIntervalChange={terrainState.handlers.onContourLinesIntervalChange}
      onContourLinesOpacityChange={terrainState.handlers.onContourLinesOpacityChange}
      onSlopesEnabledChange={terrainState.handlers.onSlopesEnabledChange}
      onSlopeResolutionChange={terrainState.handlers.onSlopeResolutionChange}
      onSlopeColorizationChange={terrainState.handlers.onSlopeColorizationChange}
      onSlopeScaleChange={terrainState.handlers.onSlopeScaleChange}
      onSlopeScaleSettingChange={terrainState.handlers.onSlopeScaleSettingChange}
      onSlopeOpacityChange={terrainState.handlers.onSlopeOpacityChange}
      onSlopeBandColorChange={terrainState.handlers.onSlopeBandColorChange}
      onSlopeBandVisibilityToggle={terrainState.handlers.onSlopeBandVisibilityToggle}
      onSlopeBandBreakpointChange={terrainState.handlers.onSlopeBandBreakpointChange}
      onWeatherEnabledChange={overlayState.handlers.onWeatherEnabledChange}
      onWeatherDateChange={overlayState.handlers.onWeatherDateChange}
      onWeatherLayerToggle={overlayState.handlers.onWeatherLayerToggle}
      onWeatherLayerModeChange={overlayState.handlers.onWeatherLayerModeChange}
      onWeatherPaletteOpacityChange={overlayState.handlers.onWeatherPaletteOpacityChange}
      onWeatherPaletteScaleSettingChange={overlayState.handlers.onWeatherPaletteScaleSettingChange}
      onWeatherPaletteBandColorChange={overlayState.handlers.onWeatherPaletteBandColorChange}
      onWeatherPaletteBandVisibilityToggle={overlayState.handlers.onWeatherPaletteBandVisibilityToggle}
      onWeatherPaletteBandBreakpointChange={overlayState.handlers.onWeatherPaletteBandBreakpointChange}
      onWindEnabledChange={overlayState.handlers.onWindEnabledChange}
      onWindDateChange={overlayState.handlers.onWindDateChange}
      onSnowEnabledChange={overlayState.handlers.onSnowEnabledChange}
      onSunlightEnabledChange={overlayState.handlers.onSunlightEnabledChange}
      onSunlightStateChange={overlayState.handlers.onSunlightStateChange}
      onRoutesEnabledChange={routeHandlers.onRoutesEnabledChange}
      onRouteColorChange={routeHandlers.onRouteColorChange}
      onRouteModeChange={routeHandlers.onRouteModeChange}
      onRouteOpacityChange={routeHandlers.onRouteOpacityChange}
      onBasemap3dQualityChange={(value) => {
        applyDem3dSelection(value);
        updateProjectControlPanel((draft) => {
          draft.basemap3dQuality = value;
        });
      }}
      onMapEnvironmentChange={(value) => {
        setActiveMapEnvironment(value);
        updateProjectControlPanel((draft) => {
          draft.mapEnvironment = value;
        });
      }}
      onRouteTraceWidthChange={routeHandlers.onRouteTraceWidthChange}
      onRouteQualityChange={routeHandlers.onRouteQualityChange}
      onRouteVisibilityToggle={routeHandlers.onRouteVisibilityToggle}
    />
  );
});
