import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useLidarManager } from '@/features/lidar/components/LidarContext';
import type { CachedTileInfo, DownloadProgress, TileCoord } from '@/features/lidar/types';

import { loadSlopeState, saveSlopeState, loadBreakpoints, saveBreakpoints } from '@/features/slope/lib/slope-persist';
import { generateDynamicCategories, clampBreakpoints } from '@/features/slope/lib/slope-config';
import { resolutionToFactor } from '@/features/slope/lib/slope-source';
import { useSlope } from '@/features/slope/hooks/useSlope';
import type { SlopeColorMode, SlopeResolutionKey } from '@/features/slope/types';

import { loadAltitudeState, saveAltitudeState } from '@/features/altitude/lib/altitude-persist';
import { buildAltitudeCategories } from '@/features/altitude/lib/altitude-config';
import {
  loadAltitudeBreakpoints,
  saveAltitudeBreakpoints,
} from '@/features/altitude/lib/altitude-persist';
import {
  altitudeBandCountFromSetting,
  clampAltitudeBreakpoints,
} from '@/features/altitude/lib/altitude-config';
import {
} from '@/features/altitude/lib/altitude-source';
import { useAltitude } from '@/features/altitude/hooks/useAltitude';
import type {
  AltitudeColorMode,
  AltitudeScaleSettingKey,
} from '@/features/altitude/types';

import { loadLabelState, saveLabelState } from '@/features/labels/lib/label-persist';
import { useLabels } from '@/features/labels/hooks/useLabels';
import type { LabelCategory } from '@/features/labels/types';

import { useWind } from '@/features/weather/hooks/useWind';
import { useSunlight, useShadowImage } from '@/features/sunlight';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import type { RouteRenderMode as ItinRouteRenderMode } from '@/features/itineraryPanel/types';

import { ControlPanel } from './ControlPanel';
import { DEFAULT_CONTROL_PANEL_STATE } from './defaultState';
import {
  createDefaultControlPanelPersistedState,
  type ControlPanelPersistedState,
  type ControlPanelSectionKey,
} from './persistedState';
import type {
  ControlPanelState,
  AltitudeBand,
  AltitudeColorization,
  AltitudeScaleSetting,
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
  SunlightState,
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
function altitudeColorModeToPanel(m: AltitudeColorMode): AltitudeColorization {
  return m === 'step' ? 'stepped' : 'gradient';
}
function altitudeColorModeFromPanel(c: AltitudeColorization): AltitudeColorMode {
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

function buildAltitudeBandsFromDynamic(
  categories: ReturnType<typeof buildAltitudeCategories>,
  hiddenIds: Set<string>,
): AltitudeBand[] {
  return categories.map((cat) => ({
    id: cat.id,
    label: cat.displayRange,
    color: cat.color,
    visible: !hiddenIds.has(cat.id),
    minMeters: cat.minMeters,
    maxMeters: cat.maxMeters,
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

  // ── LIDAR ──────────────────────────────────────────────────────────
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [hiddenTiles, setHiddenTiles] = useState<Record<string, boolean>>({});
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

  // ── Slope ──────────────────────────────────────────────────────────
  const [slopeState, setSlopeState] = useState(() => {
    const loaded = loadSlopeState();
    return {
      ...loaded,
      enabled: initialControlPanel.toggles.slopesEnabled ?? loaded.enabled,
    };
  });
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
  const [labelsEnabled, setLabelsEnabled] = useState(
    initialControlPanel.toggles.labelsEnabled,
  );
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
    () => ({
      ...DEFAULT_CONTROL_PANEL_STATE.weather,
      enabled: initialControlPanel.toggles.weatherEnabled,
    }),
  );

  // ── Wind ───────────────────────────────────────────────────────────
  const [windEnabled, setWindEnabled] = useState(initialControlPanel.toggles.windEnabled);
  useWind(isMapLoaded ? map : null, windEnabled);

  // ── Snow & Sunlight ────────────────────────────────────────────────
  const [snowEnabled, setSnowEnabled] = useState(initialControlPanel.toggles.snowEnabled);
  const [sunlightState, setSunlightState] = useState(() => ({
    ...DEFAULT_CONTROL_PANEL_STATE.sunlight,
    enabled: initialControlPanel.toggles.sunlightEnabled,
  }));
  const [altitudeState, setAltitudeState] = useState(() => {
    const loaded = loadAltitudeState();
    return {
      ...loaded,
      enabled: initialControlPanel.toggles.altitudeEnabled ?? loaded.enabled,
    };
  });
  const [altitudeBreakpointsByCount, setAltitudeBreakpointsByCount] = useState<Record<number, number[]>>(() => {
    const persisted = loadAltitudeBreakpoints();
    return persisted.byCount;
  });
  const persistAltitude = useCallback((next: typeof altitudeState) => {
    setAltitudeState(next);
    saveAltitudeState(next);
  }, []);
  const altitudeBandCount = useMemo(
    () => altitudeBandCountFromSetting(altitudeState.scaleSetting),
    [altitudeState.scaleSetting],
  );
  const currentAltitudeBreakpoints = useMemo(
    () => altitudeBreakpointsByCount[altitudeBandCount],
    [altitudeBreakpointsByCount, altitudeBandCount],
  );
  const altitudeCategories = useMemo(
    () => buildAltitudeCategories(
      altitudeState.scaleSetting,
      altitudeState.customColors,
      currentAltitudeBreakpoints,
    ),
    [altitudeState.scaleSetting, altitudeState.customColors, currentAltitudeBreakpoints],
  );
  const altitudeHiddenIds = useMemo(
    () => new Set(altitudeState.hiddenBandIds),
    [altitudeState.hiddenBandIds],
  );

  useAltitude(
    isMapLoaded ? map : null,
    isMapLoaded,
    altitudeState.enabled,
    altitudeState.opacity,
    altitudeState.colorMode,
    altitudeCategories,
    altitudeState.hiddenBandIds,
  );

  // ── Routes (right-panel "Itinéraires" section) ─────────────────────
  // Items are sourced from the active project so the right panel mirrors
  // the editor on the left in real time. Color / visibility / mode /
  // opacity edits flow back into the project store via the mutators
  // exposed by `useProjectStore`.
  const projectItineraries = projectStore?.project.itineraries ?? [];
  const [routesEnabled, setRoutesEnabled] = useState(true);
  const routeItems = useMemo(
    () =>
      projectItineraries.map((it) => ({
        id: it.id,
        label: it.name,
        color: it.color,
        mode: (it.renderMode ?? 'default') as ItinRouteRenderMode,
        opacity: it.opacity ?? 100,
        visible: it.visible !== false,
      })),
    [projectItineraries],
  );

  const handleRouteColorChange = useCallback(
    (id: string, color: string) => {
      projectStore?.setItineraryColor(id, color);
    },
    [projectStore],
  );
  const handleRouteVisibilityToggle = useCallback(
    (id: string) => {
      if (!projectStore) return;
      const current = projectStore.project.itineraries.find((i) => i.id === id);
      if (!current) return;
      projectStore.setItineraryVisibility(id, current.visible === false);
    },
    [projectStore],
  );
  const handleRouteModeChange = useCallback(
    (id: string, mode: string) => {
      const allowed: ItinRouteRenderMode[] = ['default', 'slope', 'speedEst'];
      const safe = (allowed as string[]).includes(mode)
        ? (mode as ItinRouteRenderMode)
        : 'default';
      projectStore?.setItineraryRenderMode(id, safe);
    },
    [projectStore],
  );
  const handleRouteOpacityChange = useCallback(
    (id: string, opacity: number) => {
      projectStore?.setItineraryOpacity(id, opacity);
    },
    [projectStore],
  );

  // Master "Itinéraires" toggle in the section header — when flipped it
  // hides / shows every itinerary on the map by writing each one's
  // `visible` flag in the project store. We keep `routesEnabled` as the
  // single source of truth for the section's visual state and derive it
  // from "any itinerary currently visible" so the panel state matches
  // the underlying store after edits made elsewhere (e.g. from the
  // center summary or via Supabase rehydration).
  const anyItineraryVisible = useMemo(
    () => projectItineraries.some((it) => it.visible !== false),
    [projectItineraries],
  );
  const handleRoutesEnabledChange = useCallback(
    (enabled: boolean) => {
      setRoutesEnabled(enabled);
      if (!projectStore) return;
      for (const it of projectStore.project.itineraries) {
        if ((it.visible !== false) !== enabled) {
          projectStore.setItineraryVisibility(it.id, enabled);
        }
      }
    },
    [projectStore],
  );
  // Keep the local toggle in sync with the store so external changes
  // (per-row eye click, project load) keep the master in the right state.
  useEffect(() => {
    setRoutesEnabled(anyItineraryVisible);
  }, [anyItineraryVisible]);

  // Drives Mapbox sun + atmosphere; returns sunrise/sunset for the current
  // map center and date so the SunlightSection panel can display them.
  const sunlightTimes = useSunlight(isMapLoaded ? map : null, isMapLoaded, {
    enabled: sunlightState.enabled,
    date: sunlightState.date,
    time: sunlightState.time,
  });

  // DEM-driven cast shadows — single ImageSource updated in place by a
  // dedicated worker. Time changes only re-run the sweep + image upload
  // (no Mapbox tile fetch cycle, no source rebuild).
  useShadowImage(isMapLoaded ? map : null, isMapLoaded, {
    enabled: sunlightState.enabled && sunlightState.shadowEnabled,
    sunAzimuthDeg: sunlightTimes.sunAzimuthDeg,
    sunAltitudeDeg: sunlightTimes.sunAltitudeDeg,
    opacity: sunlightState.shadowOpacity / 100,
    timeScrubbing: sunlightState.timeScrubbing,
  });

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
      routes: {
        enabled: routesEnabled,
        items: routeItems,
      },
      slopes: {
        enabled: slopeState.enabled,
        resolution: slopeState.resolution,
        colorization: colorModeToPanel(slopeState.colorMode),
        scale: slopeScale,
        scaleSetting: slopeScaleSetting,
        opacity: Math.round(slopeState.opacity * 100),
        bands: buildSlopeBandsFromDynamic(dynamicCategories, slopeBandVisibility),
      },
      altitude: {
        enabled: altitudeState.enabled,
        colorization: altitudeColorModeToPanel(altitudeState.colorMode),
        scaleSetting: altitudeState.scaleSetting,
        opacity: Math.round(altitudeState.opacity * 100),
        bands: buildAltitudeBandsFromDynamic(altitudeCategories, altitudeHiddenIds),
      },
      weather: weatherState,
      wind: { enabled: windEnabled },
      snow: { enabled: snowEnabled },
      sunlight: {
        ...sunlightState,
        sunriseTime: sunlightTimes.sunriseTime,
        sunsetTime: sunlightTimes.sunsetTime,
      },
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
    altitudeState,
    altitudeBreakpointsByCount,
    altitudeBandCount,
    currentAltitudeBreakpoints,
    altitudeCategories,
    altitudeHiddenIds,
    windEnabled,
    weatherState,
    snowEnabled,
    sunlightState,
    sunlightTimes,
    dynamicCategories,
    routesEnabled,
    routeItems,
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
  const handleAltitudeEnabled = useCallback(
    (enabled: boolean) => persistAltitude({ ...altitudeState, enabled }),
    [persistAltitude, altitudeState],
  );
  const handleAltitudeColorization = useCallback(
    (value: AltitudeColorization) =>
      persistAltitude({ ...altitudeState, colorMode: altitudeColorModeFromPanel(value) }),
    [persistAltitude, altitudeState],
  );
  const handleAltitudeScaleSetting = useCallback(
    (value: AltitudeScaleSetting) => {
      const valid: AltitudeScaleSettingKey[] = ['2 couleurs', '3 couleurs', '4 couleurs', '6 couleurs'];
      if (!valid.includes(value as AltitudeScaleSettingKey)) return;
      persistAltitude({ ...altitudeState, scaleSetting: value as AltitudeScaleSettingKey });
    },
    [persistAltitude, altitudeState],
  );
  const handleAltitudeOpacity = useCallback(
    (value: number) =>
      persistAltitude({
        ...altitudeState,
        opacity: Math.max(0, Math.min(1, value / 100)),
      }),
    [persistAltitude, altitudeState],
  );
  const handleAltitudeBreakpointChange = useCallback(
    (bandIndex: number, field: 'min' | 'max', valueMeters: number) => {
      const count = altitudeCategories.length;
      const bp = altitudeCategories.slice(1).map((cat) => cat.minMeters);

      let bpIndex: number;
      if (field === 'min') {
        if (bandIndex === 0) return;
        bpIndex = bandIndex - 1;
      } else {
        if (bandIndex === count - 1) return;
        bpIndex = bandIndex;
      }

      if (bpIndex < 0 || bpIndex >= bp.length) return;

      bp[bpIndex] = valueMeters;
      const clamped = clampAltitudeBreakpoints(bp, count);

      setAltitudeBreakpointsByCount((prev) => {
        const next = { ...prev, [count]: clamped };
        saveAltitudeBreakpoints({ bandCount: count, byCount: next });
        return next;
      });
    },
    [altitudeCategories],
  );
  const handleAltitudeBandToggle = useCallback(
    (id: string) => {
      const hidden = new Set(altitudeState.hiddenBandIds);
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      persistAltitude({ ...altitudeState, hiddenBandIds: Array.from(hidden) });
    },
    [persistAltitude, altitudeState],
  );
  const handleAltitudeBandColorChange = useCallback(
    (id: string, color: string) =>
      persistAltitude({
        ...altitudeState,
        customColors: { ...altitudeState.customColors, [id]: color },
      }),
    [persistAltitude, altitudeState],
  );

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
    (dateState: Partial<Pick<WeatherState, 'customDateEnabled' | 'date' | 'time' | 'forecastDay' | 'trendMode'>>) =>
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
  const handleSunlightEnabled = useCallback((enabled: boolean) => setSunlightState((prev) => ({ ...prev, enabled })), []);
  const handleSunlightStateChange = useCallback((changes: Partial<SunlightState>) => setSunlightState((prev) => ({ ...prev, ...changes })), []);

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

  return (
    <ControlPanel
      state={state}
      lidarDownloadProgress={lidarDownloadProgress}
      lidarDownloadError={lidarDownloadError}
      lidarDownloadModeActive={lidarDownloadModeActive}
      className={className}
      sectionsOpen={projectControlPanel.sectionsOpen}
      onSectionOpenChange={handleSectionOpenChange}
      onAltitudeEnabledChange={(enabled) => {
        handleAltitudeEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.altitudeEnabled = enabled;
        });
      }}
      onAltitudeColorizationChange={handleAltitudeColorization}
      onAltitudeScaleSettingChange={handleAltitudeScaleSetting}
      onAltitudeOpacityChange={handleAltitudeOpacity}
      onAltitudeBandColorChange={handleAltitudeBandColorChange}
      onAltitudeBandVisibilityToggle={handleAltitudeBandToggle}
      onAltitudeBandBreakpointChange={handleAltitudeBreakpointChange}
      sunlightMapExpanded={projectControlPanel.sunlightMapExpanded}
      onSunlightMapExpandedChange={(open) => {
        updateProjectControlPanel((draft) => {
          draft.sunlightMapExpanded = open;
        });
      }}
      width={width}
      onResizeStart={onResizeStart}
      isResizing={isResizing}
      /* LIDAR */
      onLidarTileToggle={handleLidarTileToggle}
      onLidarTileOpen={handleLidarTileOpen}
      onLidarTileDelete={handleLidarTileDelete}
      onLidarTileDownload={handleLidarDownload}
      /* Labels */
      onLabelsEnabledChange={(enabled) => {
        handleLabelsEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.labelsEnabled = enabled;
        });
      }}
      onLabelToggle={handleLabelToggle}
      /* Slopes */
      onSlopesEnabledChange={(enabled) => {
        handleSlopesEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.slopesEnabled = enabled;
        });
      }}
      onSlopeResolutionChange={handleSlopeResolution}
      onSlopeColorizationChange={handleSlopeColorization}
      onSlopeScaleChange={setSlopeScale}
      onSlopeScaleSettingChange={setSlopeScaleSetting}
      onSlopeOpacityChange={handleSlopeOpacity}
      onSlopeBandVisibilityToggle={handleSlopeBandToggle}
      onSlopeBandBreakpointChange={handleBreakpointChange}
      /* Weather */
      onWeatherEnabledChange={(enabled) => {
        handleWeatherEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.weatherEnabled = enabled;
        });
      }}
      onWeatherTabChange={handleWeatherTabChange}
      onWeatherDateChange={handleWeatherDateChange}
      onWeatherLayerToggle={handleWeatherLayerToggle}
      onWeatherLayerModeChange={handleWeatherLayerModeChange}
      onWeatherAddAlert={handleWeatherAddAlert}
      /* Wind */
      onWindEnabledChange={(enabled) => {
        handleWindEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.windEnabled = enabled;
        });
      }}
      /* Snow & Sunlight */
      onSnowEnabledChange={(enabled) => {
        handleSnowEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.snowEnabled = enabled;
        });
      }}
      onSunlightEnabledChange={(enabled) => {
        handleSunlightEnabled(enabled);
        updateProjectControlPanel((draft) => {
          draft.toggles.sunlightEnabled = enabled;
        });
      }}
      onSunlightStateChange={handleSunlightStateChange}
      /* Routes (itineraries from active project) */
      onRoutesEnabledChange={handleRoutesEnabledChange}
      onRouteColorChange={handleRouteColorChange}
      onRouteModeChange={handleRouteModeChange}
      onRouteOpacityChange={handleRouteOpacityChange}
      onRouteVisibilityToggle={handleRouteVisibilityToggle}
    />
  );
}
