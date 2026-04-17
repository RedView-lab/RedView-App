import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useLidarManager } from '@/features/lidar/components/LidarContext';
import type { CachedTileInfo, TileCoord } from '@/features/lidar/types';

import { loadSlopeState, saveSlopeState } from '@/features/slope/lib/slope-persist';
import { SLOPE_CATEGORIES, degToPercent } from '@/features/slope/lib/slope-config';
import { useSlope } from '@/features/slope/hooks/useSlope';
import type { SlopeColorMode } from '@/features/slope/types';

import { loadLabelState, saveLabelState } from '@/features/labels/lib/label-persist';
import { useLabels } from '@/features/labels/hooks/useLabels';
import type { LabelCategory } from '@/features/labels/types';

import { useWind } from '@/features/weather/hooks/useWind';

import { ControlPanel } from './ControlPanel';
import { DEFAULT_CONTROL_PANEL_STATE } from './defaultState';
import type {
  ControlPanelState,
  LabelKey,
  LabelsState,
  SlopeBand,
  SlopeColorization,
} from './types';

interface ControlPanelContainerProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  onToggleLidarDownloadMode?: () => void;
  lidarDownloadModeActive?: boolean;
}

// ── Adapters ──────────────────────────────────────────────────────────

function colorModeToPanel(m: SlopeColorMode): SlopeColorization {
  return m === 'step' ? 'stepped' : 'gradient';
}
function colorModeFromPanel(c: SlopeColorization): SlopeColorMode {
  return c === 'stepped' ? 'step' : 'gradient';
}

/** Panel label key → backend label category (null = ui-only key, no backend). */
const PANEL_TO_BACKEND_LABEL: Record<LabelKey, LabelCategory | null> = {
  poiLabels: 'poi',
  roads: 'roads',
  cities: 'places',
  states: null, // no backend equivalent — ui-only toggle
  naturalParks: 'naturalParks',
  countries: 'countries',
  waterBody: 'waterBody',
};

function buildSlopeBandsFromCategories(visibilityById: Record<string, boolean>): SlopeBand[] {
  return SLOPE_CATEGORIES.map((cat) => ({
    id: cat.id,
    percentRange: `${degToPercent(cat.minDeg)}% - ${degToPercent(cat.maxDeg)}%`,
    degreeRange: `${cat.minDeg}° - ${cat.maxDeg}° (${cat.label})`,
    color: cat.color,
    visible: visibilityById[cat.id] ?? true,
  }));
}

function formatLidarTileLabel(info: CachedTileInfo): string {
  const sizeMb = Math.round(info.sizeBytes / (1024 * 1024));
  const year = new Date(info.cachedAt).getFullYear();
  return `Tuile ${info.coord.xKm}×${info.coord.yKm} (LIDAR) (${sizeMb}mo) (${year} IGN)`;
}
function tileKey(c: TileCoord): string {
  return `${c.xKm}_${c.yKm}_${c.projection}`;
}

// ── Container ─────────────────────────────────────────────────────────

export function ControlPanelContainer({
  map,
  isMapLoaded,
  onToggleLidarDownloadMode,
  lidarDownloadModeActive,
}: ControlPanelContainerProps) {
  const lidarManager = useLidarManager();

  // ── LIDAR ──────────────────────────────────────────────────────────
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [hiddenTiles, setHiddenTiles] = useState<Record<string, boolean>>({});

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
      if (evt.type === 'tileLoaded' || evt.type === 'tileRemoved') void refreshTiles();
    });
  }, [lidarManager, refreshTiles]);

  // ── Slope ──────────────────────────────────────────────────────────
  const [slopeState, setSlopeState] = useState(loadSlopeState);
  const [slopeBandVisibility, setSlopeBandVisibility] = useState<Record<string, boolean>>({});

  const persistSlope = useCallback((next: typeof slopeState) => {
    setSlopeState(next);
    saveSlopeState(next);
  }, []);

  useSlope(
    isMapLoaded ? map : null,
    isMapLoaded,
    slopeState.enabled,
    slopeState.opacity,
    slopeState.colorMode,
  );

  // ── Labels ─────────────────────────────────────────────────────────
  const [labelBackend, setLabelBackend] = useState(() => loadLabelState());
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [statesUiToggle, setStatesUiToggle] = useState(true); // ui-only, no backend

  // When master toggle is off, force every backend category to false.
  const effectiveLabelState = useMemo(() => {
    if (labelsEnabled) return labelBackend;
    const off = { ...labelBackend };
    for (const k of Object.keys(off) as LabelCategory[]) off[k] = false;
    return off;
  }, [labelBackend, labelsEnabled]);

  useLabels(map, isMapLoaded, effectiveLabelState);

  // ── Wind ───────────────────────────────────────────────────────────
  const [windEnabled, setWindEnabled] = useState(false);
  useWind(isMapLoaded ? map : null, windEnabled);

  // ── Build ControlPanel state ───────────────────────────────────────
  const state: ControlPanelState = useMemo(() => {
    const base = DEFAULT_CONTROL_PANEL_STATE;
    const panelLabels: LabelsState = {
      poiLabels: labelBackend.poi,
      roads: labelBackend.roads,
      cities: labelBackend.places,
      states: statesUiToggle,
      naturalParks: labelBackend.naturalParks,
      countries: labelBackend.countries,
      waterBody: labelBackend.waterBody,
    };

    return {
      ...base,
      lidarTiles: cachedTiles.map((info) => ({
        id: tileKey(info.coord),
        label: formatLidarTileLabel(info),
        sizeMb: Math.round(info.sizeBytes / (1024 * 1024)),
        year: new Date(info.cachedAt).getFullYear(),
        source: 'LIDAR',
        visible: !hiddenTiles[tileKey(info.coord)],
      })),
      labels: { enabled: labelsEnabled, state: panelLabels },
      slopes: {
        enabled: slopeState.enabled,
        resolution: '1m (LIDAR)',
        colorization: colorModeToPanel(slopeState.colorMode),
        opacity: Math.round(slopeState.opacity * 100),
        bands: buildSlopeBandsFromCategories(slopeBandVisibility),
      },
      wind: { enabled: windEnabled },
    };
  }, [
    cachedTiles,
    hiddenTiles,
    labelBackend,
    labelsEnabled,
    statesUiToggle,
    slopeState,
    slopeBandVisibility,
    windEnabled,
  ]);

  // ── Handlers ───────────────────────────────────────────────────────

  const handleLidarTileToggle = useCallback((id: string) => {
    setHiddenTiles((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);
  const handleLidarTileDelete = useCallback(
    (id: string) => {
      const info = cachedTiles.find((t) => tileKey(t.coord) === id);
      if (info) void lidarManager.removeTile(info.coord);
    },
    [cachedTiles, lidarManager],
  );
  const handleLidarTileOpen = useCallback(
    (id: string) => {
      const info = cachedTiles.find((t) => tileKey(t.coord) === id);
      if (info) lidarManager.openViewer(info.coord);
    },
    [cachedTiles, lidarManager],
  );
  const handleLidarDownload = useCallback(() => {
    onToggleLidarDownloadMode?.();
  }, [onToggleLidarDownloadMode]);

  const handleSlopesEnabled = useCallback(
    (enabled: boolean) => persistSlope({ ...slopeState, enabled }),
    [persistSlope, slopeState],
  );
  const handleSlopeColorization = useCallback(
    (c: SlopeColorization) => persistSlope({ ...slopeState, colorMode: colorModeFromPanel(c) }),
    [persistSlope, slopeState],
  );
  const handleSlopeOpacity = useCallback(
    (v: number) => persistSlope({ ...slopeState, opacity: Math.max(0, Math.min(1, v / 100)) }),
    [persistSlope, slopeState],
  );
  const handleSlopeBandToggle = useCallback((id: string) => {
    setSlopeBandVisibility((prev) => ({ ...prev, [id]: prev[id] === false ? true : false }));
  }, []);

  const handleLabelsEnabled = useCallback((enabled: boolean) => setLabelsEnabled(enabled), []);
  const handleLabelToggle = useCallback((key: LabelKey, checked: boolean) => {
    if (key === 'states') {
      setStatesUiToggle(checked);
      return;
    }
    const backendKey = PANEL_TO_BACKEND_LABEL[key];
    if (!backendKey) return;
    setLabelBackend((prev) => {
      const next = { ...prev, [backendKey]: checked };
      saveLabelState(next);
      return next;
    });
  }, []);

  const handleWindEnabled = useCallback((enabled: boolean) => setWindEnabled(enabled), []);

  const className = lidarDownloadModeActive ? 'rvc-panel--lidar-selecting' : undefined;

  return (
    <ControlPanel
      state={state}
      className={className}
      /* LIDAR */
      onLidarTileToggle={handleLidarTileToggle}
      onLidarTileOpen={handleLidarTileOpen}
      onLidarTileDelete={handleLidarTileDelete}
      onLidarTileDownload={handleLidarDownload}
      /* Labels */
      onLabelsEnabledChange={handleLabelsEnabled}
      onLabelToggle={handleLabelToggle}
      /* Slopes */
      onSlopesEnabledChange={handleSlopesEnabled}
      onSlopeColorizationChange={handleSlopeColorization}
      onSlopeOpacityChange={handleSlopeOpacity}
      onSlopeBandVisibilityToggle={handleSlopeBandToggle}
      /* Wind */
      onWindEnabledChange={handleWindEnabled}
    />
  );
}
