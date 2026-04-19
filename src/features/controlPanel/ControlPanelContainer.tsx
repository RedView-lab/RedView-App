import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useLidarManager } from '@/features/lidar/components/LidarContext';
import type { CachedTileInfo, TileCoord } from '@/features/lidar/types';

import { loadSlopeState, saveSlopeState, loadBreakpoints, saveBreakpoints } from '@/features/slope/lib/slope-persist';
import { generateDynamicCategories, clampBreakpoints } from '@/features/slope/lib/slope-config';
import { resolutionToFactor } from '@/features/slope/lib/slope-source';
import { useSlope } from '@/features/slope/hooks/useSlope';
import type { SlopeColorMode, SlopeResolutionKey } from '@/features/slope/types';

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
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
  WeatherLayerKey,
  WeatherRenderMode,
  WeatherState,
  WeatherTab,
} from './types';
import type { SlopeCategory } from '@/features/slope/types';

interface ControlPanelContainerProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  onToggleLidarDownloadMode?: () => void;
  lidarDownloadModeActive?: boolean;
  width?: number;
  onResizeStart?: (ev: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
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

function bandCountFromSetting(setting: SlopeScaleSetting): number {
  const m = /^(\d+)/.exec(setting);
  return m ? Number(m[1]) : 4;
}

function buildSlopeBandsFromDynamic(
  categories: SlopeCategory[],
  visibilityById: Record<string, boolean>,
): SlopeBand[] {
  return categories.map((cat) => ({
    id: cat.id,
    percentRange: cat.displayRange,
    degreeRange: `${cat.minDeg}° - ${cat.maxDeg}° (${cat.label})`,
    label: `${cat.displayRange} (${cat.label})`,
    color: cat.color,
    visible: visibilityById[cat.id] ?? true,
    minDeg: cat.minDeg,
    maxDeg: cat.maxDeg,
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
  width,
  onResizeStart,
  isResizing,
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
  const [slopeScale, setSlopeScale] = useState<SlopeScale>('percent');
  const [slopeScaleSetting, setSlopeScaleSetting] = useState<SlopeScaleSetting>('4 couleurs');

  // Custom breakpoints state — keyed by band count for independent persistence
  const [breakpointsByCount, setBreakpointsByCount] = useState<Record<number, number[]>>(() => {
    const persisted = loadBreakpoints();
    return persisted.byCount;
  });

  const persistSlope = useCallback((next: typeof slopeState) => {
    setSlopeState(next);
    saveSlopeState(next);
  }, []);

  // Current band count
  const bandCount = useMemo(() => bandCountFromSetting(slopeScaleSetting), [slopeScaleSetting]);

  // Current custom breakpoints for this band count (undefined = use defaults)
  const currentBreakpoints = useMemo(
    () => breakpointsByCount[bandCount],
    [breakpointsByCount, bandCount],
  );

  // Dynamic categories based on scaleSetting + custom breakpoints
  const dynamicCategories = useMemo(
    () => generateDynamicCategories(bandCount, currentBreakpoints),
    [bandCount, currentBreakpoints],
  );

  useSlope(
    isMapLoaded ? map : null,
    isMapLoaded,
    slopeState.enabled,
    slopeState.opacity,
    slopeState.colorMode,
    useMemo(
      () =>
        dynamicCategories.filter((cat) => slopeBandVisibility[cat.id] === false).map(
          (cat) => [cat.minDeg, cat.maxDeg] as [number, number],
        ),
      [slopeBandVisibility, dynamicCategories],
    ),
    dynamicCategories,
    resolutionToFactor(slopeState.resolution),
  );

  // ── Breakpoint edit handler ────────────────────────────────────────
  // Called when user edits a band's min or max degree inline.
  // bandIndex: 0-based band index
  // field: 'min' → edits the lower boundary, 'max' → edits the upper boundary
  // valueDeg: raw user-entered angle in degrees
  const handleBreakpointChange = useCallback(
    (bandIndex: number, field: 'min' | 'max', valueDeg: number) => {
      // Build the current internal breakpoints from dynamic categories
      const cats = dynamicCategories;
      const count = cats.length;

      // Internal breakpoints are the boundaries between bands (length = count - 1)
      const bp = cats.slice(1).map((c) => c.minDeg);

      // Determine which internal breakpoint is being edited:
      //   - Editing band[i].min → internal breakpoint index i - 1 (band 0 min is always 0°)
      //   - Editing band[i].max → internal breakpoint index i (last band max is always 90°)
      let bpIndex: number;
      if (field === 'min') {
        // First band min is fixed at 0° — ignore
        if (bandIndex === 0) return;
        bpIndex = bandIndex - 1;
      } else {
        // Last band max is fixed at 90° — ignore
        if (bandIndex === count - 1) return;
        bpIndex = bandIndex;
      }

      // Sanity check
      if (bpIndex < 0 || bpIndex >= bp.length) return;

      // Set the new value
      bp[bpIndex] = valueDeg;

      // Validate and clamp
      const clamped = clampBreakpoints(bp, count);

      // Persist
      setBreakpointsByCount((prev) => {
        const next = { ...prev, [count]: clamped };
        saveBreakpoints({ bandCount: count, byCount: next });
        return next;
      });
    },
    [dynamicCategories],
  );

  // When band count changes, clear slope tile cache so new breakpoints take effect
  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
  }, [bandCount, currentBreakpoints]);

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

  // ── Weather ────────────────────────────────────────────────────────
  const [weatherState, setWeatherState] = useState<WeatherState>(
    DEFAULT_CONTROL_PANEL_STATE.weather,
  );

  // ── Wind ───────────────────────────────────────────────────────────
  const [windEnabled, setWindEnabled] = useState(false);
  useWind(isMapLoaded ? map : null, windEnabled);

  // ── Snow & Sunlight ────────────────────────────────────────────────
  const [snowEnabled, setSnowEnabled] = useState(false);
  const [sunlightEnabled, setSunlightEnabled] = useState(false);

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
        resolution: slopeState.resolution,
        colorization: colorModeToPanel(slopeState.colorMode),
        scale: slopeScale,
        scaleSetting: slopeScaleSetting,
        opacity: Math.round(slopeState.opacity * 100),
        bands: buildSlopeBandsFromDynamic(dynamicCategories, slopeBandVisibility),
      },
      weather: weatherState,
      wind: { enabled: windEnabled },
      snow: { enabled: snowEnabled },
      sunlight: { enabled: sunlightEnabled },
    };
  }, [
    cachedTiles,
    hiddenTiles,
    labelBackend,
    labelsEnabled,
    statesUiToggle,
    slopeState,
    slopeBandVisibility,
    slopeScale,
    slopeScaleSetting,
    windEnabled,
    weatherState,
    snowEnabled,
    sunlightEnabled,
    dynamicCategories,
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
  const handleSlopeResolution = useCallback(
    (r: SlopeResolution) => {
      // Validate against the known set; ignore unknown values silently.
      const valid: SlopeResolutionKey[] = ['0.40m (LIDAR)', '1m', '5m', '10m'];
      if (!valid.includes(r as SlopeResolutionKey)) return;
      persistSlope({ ...slopeState, resolution: r as SlopeResolutionKey });
    },
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

  // ── Weather handlers ───────────────────────────────────────────────
  const handleWeatherEnabled = useCallback(
    (enabled: boolean) => setWeatherState((prev) => ({ ...prev, enabled })),
    [],
  );
  const handleWeatherTabChange = useCallback(
    (tab: WeatherTab) => setWeatherState((prev) => ({ ...prev, tab })),
    [],
  );
  const handleWeatherDateChange = useCallback(
    (dateState: Pick<WeatherState, 'customDateEnabled' | 'date' | 'time'>) =>
      setWeatherState((prev) => ({ ...prev, ...dateState })),
    [],
  );
  const handleWeatherLayerToggle = useCallback(
    (key: WeatherLayerKey, enabled: boolean) =>
      setWeatherState((prev) => ({
        ...prev,
        layers: prev.layers.map((l) => (l.key === key ? { ...l, enabled } : l)),
      })),
    [],
  );
  const handleWeatherLayerModeChange = useCallback(
    (key: WeatherLayerKey, mode: WeatherRenderMode) =>
      setWeatherState((prev) => ({
        ...prev,
        layers: prev.layers.map((l) => (l.key === key ? { ...l, mode } : l)),
      })),
    [],
  );
  const handleWeatherAddAlert = useCallback(() => {
    // TODO: implement alert UI
    console.log('[weather] add alert triggered');
  }, []);

  const handleWindEnabled = useCallback((enabled: boolean) => setWindEnabled(enabled), []);
  const handleSnowEnabled = useCallback((enabled: boolean) => setSnowEnabled(enabled), []);
  const handleSunlightEnabled = useCallback((enabled: boolean) => setSunlightEnabled(enabled), []);

  const className = lidarDownloadModeActive ? 'rvc-panel--lidar-selecting' : undefined;

  return (
    <ControlPanel
      state={state}
      className={className}
      width={width}
      onResizeStart={onResizeStart}
      isResizing={isResizing}
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
      onSlopeResolutionChange={handleSlopeResolution}
      onSlopeColorizationChange={handleSlopeColorization}
      onSlopeScaleChange={setSlopeScale}
      onSlopeScaleSettingChange={setSlopeScaleSetting}
      onSlopeOpacityChange={handleSlopeOpacity}
      onSlopeBandVisibilityToggle={handleSlopeBandToggle}
      onSlopeBandBreakpointChange={handleBreakpointChange}
      /* Weather */
      onWeatherEnabledChange={handleWeatherEnabled}
      onWeatherTabChange={handleWeatherTabChange}
      onWeatherDateChange={handleWeatherDateChange}
      onWeatherLayerToggle={handleWeatherLayerToggle}
      onWeatherLayerModeChange={handleWeatherLayerModeChange}
      onWeatherAddAlert={handleWeatherAddAlert}
      /* Wind */
      onWindEnabledChange={handleWindEnabled}
      /* Snow & Sunlight */
      onSnowEnabledChange={handleSnowEnabled}
      onSunlightEnabledChange={handleSunlightEnabled}
    />
  );
}
