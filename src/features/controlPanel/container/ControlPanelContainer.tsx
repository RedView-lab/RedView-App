import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  OverlayReloadRegistrar,
  OverlayStatusReporter,
} from '@/features/map3d/overlayStatus';

import { useLidarManager } from '@/features/lidar/components/LidarContext';
import type { CachedTileInfo, DownloadProgress, TileCoord } from '@/features/lidar/types';
import { loadLidarTileLabels, setLidarTileLabel } from '@/features/lidar/tileLabels';
import { useProjectStoreOptional } from '@/features/itineraryPanel';
import type { RouteRenderMode as ItinRouteRenderMode } from '@/features/itineraryPanel/types';

import { ControlPanel } from '../ControlPanel';
import { DEFAULT_CONTROL_PANEL_STATE } from '../defaultState';
import {
  createDefaultControlPanelPersistedState,
  type ControlPanelPersistedState,
  type ControlPanelSectionKey,
} from '../persistedState';
import type { ControlPanelState } from '../types';
import { useControlPanelOverlayState } from './useControlPanelOverlayState';
import { useControlPanelTerrainState } from './useControlPanelTerrainState';

export interface ControlPanelContainerProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  onWeatherOverlayStatusChange?: OverlayStatusReporter;
  onWeatherOverlayReloadChange?: OverlayReloadRegistrar;
  onShadowOverlayStatusChange?: OverlayStatusReporter;
  onShadowOverlayReloadChange?: OverlayReloadRegistrar;
  onToggleLidarDownloadMode?: () => void;
  lidarDownloadModeActive?: boolean;
  width?: number;
  onResizeStart?: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
}

function formatLidarTileLabel(info: CachedTileInfo): string {
  const sizeMb = Math.round(info.sizeBytes / (1024 * 1024));
  const year = new Date(info.cachedAt).getFullYear();
  return `Tuile ${info.coord.xKm}×${info.coord.yKm} (LIDAR) (${sizeMb}mo) (${year} IGN)`;
}

function tileKey(coord: TileCoord): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}`;
}

export function ControlPanelContainer({
  map,
  isMapLoaded,
  onWeatherOverlayStatusChange,
  onWeatherOverlayReloadChange,
  onShadowOverlayStatusChange,
  onShadowOverlayReloadChange,
  onToggleLidarDownloadMode,
  lidarDownloadModeActive,
  width,
  onResizeStart,
  isResizing,
}: ControlPanelContainerProps) {
  const lidarManager = useLidarManager();
  const projectStore = useProjectStoreOptional();
  const initialControlPanel =
    projectStore?.project.controlPanel ?? createDefaultControlPanelPersistedState();

  const updateProjectControlPanel = useCallback(
    (mut: (draft: ControlPanelPersistedState) => void) => {
      if (!projectStore) return;
      projectStore.setProject((prev) => {
        const controlPanel = structuredClone(
          prev.controlPanel ?? createDefaultControlPanelPersistedState(),
        );
        mut(controlPanel);
        return { ...prev, controlPanel };
      });
    },
    [projectStore],
  );

  const terrainState = useControlPanelTerrainState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
  });
  const overlayState = useControlPanelOverlayState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    onWeatherOverlayStatusChange,
    onWeatherOverlayReloadChange,
    onShadowOverlayStatusChange,
    onShadowOverlayReloadChange,
  });

  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [hiddenTiles, setHiddenTiles] = useState<Record<string, boolean>>(
    () => initialControlPanel.lidarTilesHidden ?? {},
  );
  const [customLabels, setCustomLabels] = useState<Record<string, string>>(
    () => loadLidarTileLabels(),
  );
  const [lidarDownloadProgress, setLidarDownloadProgress] = useState<DownloadProgress | null>(null);
  const [lidarDownloadError, setLidarDownloadError] = useState<string | null>(null);

  const refreshTiles = useCallback(async () => {
    try {
      setCachedTiles(await lidarManager.getCachedTiles());
    } catch (err) {
      console.warn('[controlPanel] getCachedTiles failed', err);
    }
  }, [lidarManager]);

  useEffect(() => {
    void refreshTiles();
    return lidarManager.on((evt) => {
      if (evt.type === 'progress' && evt.progress) {
        setLidarDownloadProgress(evt.progress);
        setLidarDownloadError(null);
      }
      if (evt.type === 'tileLoaded' || evt.type === 'tileRemoved') {
        setLidarDownloadProgress(null);
        if (evt.type === 'tileLoaded') setLidarDownloadError(null);
        void refreshTiles();
      }
      if (evt.type === 'error') {
        setLidarDownloadProgress(null);
        setLidarDownloadError(evt.error ?? evt.message ?? 'Erreur LiDAR');
      }
    });
  }, [lidarManager, refreshTiles]);

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.lidarTilesHidden = structuredClone(hiddenTiles);
    });
  }, [hiddenTiles, updateProjectControlPanel]);

  const lidarTiles = useMemo(
    () => cachedTiles.map((info) => {
      const id = tileKey(info.coord);
      return {
        id,
        label: customLabels[id] ?? formatLidarTileLabel(info),
        sizeMb: Math.round(info.sizeBytes / (1024 * 1024)),
        year: new Date(info.cachedAt).getFullYear(),
        source: 'LIDAR' as const,
        visible: !hiddenTiles[id],
      };
    }),
    [cachedTiles, customLabels, hiddenTiles],
  );

  const projectItineraries = projectStore?.project.itineraries ?? [];
  const [routesEnabled, setRoutesEnabled] = useState(true);
  const routeItems = useMemo(
    () =>
      projectItineraries.map((itinerary) => ({
        id: itinerary.id,
        label: itinerary.name,
        color: itinerary.color,
        mode: (itinerary.renderMode ?? 'default') as ItinRouteRenderMode,
        opacity: itinerary.opacity ?? 100,
        visible: itinerary.visible !== false,
      })),
    [projectItineraries],
  );
  const anyItineraryVisible = useMemo(
    () => projectItineraries.some((itinerary) => itinerary.visible !== false),
    [projectItineraries],
  );

  useEffect(() => {
    setRoutesEnabled(anyItineraryVisible);
  }, [anyItineraryVisible]);

  const className = lidarDownloadModeActive ? 'rvc-panel--lidar-selecting' : undefined;
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

  const state: ControlPanelState = useMemo(
    () => ({
      ...DEFAULT_CONTROL_PANEL_STATE,
      lidarTiles,
      routes: { enabled: routesEnabled, items: routeItems },
      labels: overlayState.slices.labels,
      slopes: terrainState.slices.slopes,
      altitude: terrainState.slices.altitude,
      weather: overlayState.slices.weather,
      wind: overlayState.slices.wind,
      snow: overlayState.slices.snow,
      sunlight: overlayState.slices.sunlight,
    }),
    [
      lidarTiles,
      overlayState.slices.labels,
      overlayState.slices.snow,
      overlayState.slices.sunlight,
      overlayState.slices.weather,
      overlayState.slices.wind,
      routeItems,
      routesEnabled,
      terrainState.slices.altitude,
      terrainState.slices.slopes,
    ],
  );

  return (
    <ControlPanel
      state={state}
      lidarDownloadProgress={lidarDownloadProgress}
      lidarDownloadError={lidarDownloadError}
      lidarDownloadModeActive={lidarDownloadModeActive}
      className={className}
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
      onLidarTileToggle={(id) => setHiddenTiles((prev) => ({ ...prev, [id]: !prev[id] }))}
      onLidarTileOpen={(id) => {
        const info = cachedTiles.find((tile) => tileKey(tile.coord) === id);
        if (info) lidarManager.openViewer(info.coord);
      }}
      onLidarTileDelete={(id) => {
        const info = cachedTiles.find((tile) => tileKey(tile.coord) === id);
        if (info) void lidarManager.removeTile(info.coord);
      }}
      onLidarTileRename={(id, name) => {
        const next = setLidarTileLabel(id, name);
        setCustomLabels(next);
      }}
      onLidarTileDownload={() => {
        onToggleLidarDownloadMode?.();
      }}
      onLabelsEnabledChange={overlayState.handlers.onLabelsEnabledChange}
      onLabelToggle={overlayState.handlers.onLabelToggle}
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
      onWeatherTabChange={overlayState.handlers.onWeatherTabChange}
      onWeatherDateChange={overlayState.handlers.onWeatherDateChange}
      onWeatherLayerToggle={overlayState.handlers.onWeatherLayerToggle}
      onWeatherLayerModeChange={overlayState.handlers.onWeatherLayerModeChange}
      onWeatherPaletteOpacityChange={overlayState.handlers.onWeatherPaletteOpacityChange}
      onWeatherPaletteScaleSettingChange={overlayState.handlers.onWeatherPaletteScaleSettingChange}
      onWeatherPaletteBandColorChange={overlayState.handlers.onWeatherPaletteBandColorChange}
      onWeatherPaletteBandVisibilityToggle={overlayState.handlers.onWeatherPaletteBandVisibilityToggle}
      onWeatherPaletteBandBreakpointChange={overlayState.handlers.onWeatherPaletteBandBreakpointChange}
      onWeatherAddAlert={overlayState.handlers.onWeatherAddAlert}
      onWindEnabledChange={overlayState.handlers.onWindEnabledChange}
      onSnowEnabledChange={overlayState.handlers.onSnowEnabledChange}
      onSunlightEnabledChange={overlayState.handlers.onSunlightEnabledChange}
      onSunlightStateChange={overlayState.handlers.onSunlightStateChange}
      onRoutesEnabledChange={(enabled) => {
        setRoutesEnabled(enabled);
        if (!projectStore) return;
        for (const itinerary of projectStore.project.itineraries) {
          if ((itinerary.visible !== false) !== enabled) {
            projectStore.setItineraryVisibility(itinerary.id, enabled);
          }
        }
      }}
      onRouteColorChange={(id, color) => {
        projectStore?.setItineraryColor(id, color);
      }}
      onRouteModeChange={(id, mode) => {
        const allowed: ItinRouteRenderMode[] = ['default', 'slope', 'speedEst'];
        const safe = (allowed as string[]).includes(mode)
          ? (mode as ItinRouteRenderMode)
          : 'default';
        projectStore?.setItineraryRenderMode(id, safe);
      }}
      onRouteOpacityChange={(id, opacity) => {
        projectStore?.setItineraryOpacity(id, opacity);
      }}
      onRouteVisibilityToggle={(id) => {
        if (!projectStore) return;
        const current = projectStore.project.itineraries.find((itinerary) => itinerary.id === id);
        if (!current) return;
        projectStore.setItineraryVisibility(id, current.visible === false);
      }}
    />
  );
}
