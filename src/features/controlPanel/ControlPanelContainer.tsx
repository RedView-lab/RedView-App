import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useLidarManager } from '@/features/lidar/components/LidarContext';
import type { CachedTileInfo, TileCoord } from '@/features/lidar/types';

import { loadSlopeState, saveSlopeState } from '@/features/slope/lib/slope-persist';
import { SLOPE_CATEGORIES, degToPercent } from '@/features/slope/lib/slope-config';
import { useSlope } from '@/features/slope/hooks/useSlope';
import type { SlopeColorMode } from '@/features/slope/types';

import { ControlPanel } from './ControlPanel';
import { DEFAULT_CONTROL_PANEL_STATE } from './defaultState';
import type {
  ControlPanelState,
  SlopeBand,
  SlopeColorization,
} from './types';

interface ControlPanelContainerProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  /** When true, a click on the map will trigger a LIDAR tile download. */
  onToggleLidarDownloadMode?: () => void;
  /** Currently active LIDAR click-to-download selection mode. */
  lidarDownloadModeActive?: boolean;
}

// ── Adapters: backend ⇄ ControlPanel types ─────────────────────────────────

/**
 * slope backend ("gradient" | "step") ⇄ panel ("gradient" | "stepped").
 * Panel labels say "Dégradé" / "Par paliers".
 */
function colorModeToPanel(m: SlopeColorMode): SlopeColorization {
  return m === 'step' ? 'stepped' : 'gradient';
}
function colorModeFromPanel(c: SlopeColorization): SlopeColorMode {
  return c === 'stepped' ? 'step' : 'gradient';
}

/** Build panel bands from shared SLOPE_CATEGORIES so the legend stays in sync. */
function buildSlopeBandsFromCategories(visibilityById: Record<string, boolean>): SlopeBand[] {
  return SLOPE_CATEGORIES.map((cat) => ({
    id: cat.id,
    percentRange: `${degToPercent(cat.minDeg)}% - ${degToPercent(cat.maxDeg)}%`,
    degreeRange: `${cat.minDeg}° - ${cat.maxDeg}° (${cat.label})`,
    color: cat.color,
    visible: visibilityById[cat.id] ?? true,
  }));
}

/** Format a cached LIDAR tile into the label shown in the Figma design. */
function formatLidarTileLabel(info: CachedTileInfo): string {
  const sizeMb = Math.round(info.sizeBytes / (1024 * 1024));
  const year = new Date(info.cachedAt).getFullYear();
  return `Tuile ${info.coord.xKm}×${info.coord.yKm} (LIDAR) (${sizeMb}mo) (${year} IGN)`;
}

function tileKey(c: TileCoord): string {
  return `${c.xKm}_${c.yKm}_${c.projection}`;
}

// ── Container ─────────────────────────────────────────────────────────

/**
 * Wires the ControlPanel to live LIDAR (cached tiles + delete) and slope
 * (enable / opacity / color mode / layer injection) backends.
 *
 * Everything else (basemaps, labels, routes, weather, …) stays on the
 * default mock state for now — handlers are stubbed and safe.
 */
export function ControlPanelContainer({
  map,
  isMapLoaded,
  onToggleLidarDownloadMode,
  lidarDownloadModeActive,
}: ControlPanelContainerProps) {
  const lidarManager = useLidarManager();

  // ── LIDAR: cached tiles + per-tile hidden state (ui-only) ─────────────
  const [cachedTiles, setCachedTiles] = useState<CachedTileInfo[]>([]);
  const [hiddenTiles, setHiddenTiles] = useState<Record<string, boolean>>({});

  const refreshTiles = useCallback(async () => {
    try {
      const list = await lidarManager.getCachedTiles();
      setCachedTiles(list);
    } catch (err) {
      console.warn('[controlPanel] getCachedTiles failed', err);
    }
  }, [lidarManager]);

  useEffect(() => {
    void refreshTiles();
    const unsubscribe = lidarManager.on((evt) => {
      if (evt.type === 'tileLoaded' || evt.type === 'tileRemoved') {
        void refreshTiles();
      }
    });
    return unsubscribe;
  }, [lidarManager, refreshTiles]);

  // ── Slope: persisted backend state ────────────────────────────────────
  const [slopeState, setSlopeState] = useState(loadSlopeState);
  const [slopeBandVisibility, setSlopeBandVisibility] = useState<Record<string, boolean>>({});

  const persistSlope = useCallback((next: typeof slopeState) => {
    setSlopeState(next);
    saveSlopeState(next);
  }, []);

  // Inject slope layer into the map when enabled.
  useSlope(
    isMapLoaded ? map : null,
    isMapLoaded,
    slopeState.enabled,
    slopeState.opacity,
    slopeState.colorMode,
  );

  // ── Build the full ControlPanel state ─────────────────────────────────
  const state: ControlPanelState = useMemo(() => {
    const base = DEFAULT_CONTROL_PANEL_STATE;

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
      slopes: {
        enabled: slopeState.enabled,
        resolution: '1m (LIDAR)',
        colorization: colorModeToPanel(slopeState.colorMode),
        opacity: Math.round(slopeState.opacity * 100),
        bands: buildSlopeBandsFromCategories(slopeBandVisibility),
      },
    };
  }, [cachedTiles, hiddenTiles, slopeState, slopeBandVisibility]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleLidarTileToggle = useCallback((id: string) => {
    setHiddenTiles((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleLidarTileDelete = useCallback(
    (id: string) => {
      const info = cachedTiles.find((t) => tileKey(t.coord) === id);
      if (!info) return;
      void lidarManager.removeTile(info.coord);
    },
    [cachedTiles, lidarManager],
  );

  const handleLidarDownload = useCallback(() => {
    // Figma button "Télécharger une tuile LIDAR" — enters map-click selection mode.
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

  // Visual feedback on the "Télécharger" button when selection mode is on.
  const className = lidarDownloadModeActive ? 'rvc-panel--lidar-selecting' : undefined;

  return (
    <ControlPanel
      state={state}
      className={className}
      /* LIDAR */
      onLidarTileToggle={handleLidarTileToggle}
      onLidarTileDelete={handleLidarTileDelete}
      onLidarTileDownload={handleLidarDownload}
      /* Slopes */
      onSlopesEnabledChange={handleSlopesEnabled}
      onSlopeColorizationChange={handleSlopeColorization}
      onSlopeOpacityChange={handleSlopeOpacity}
      onSlopeBandVisibilityToggle={handleSlopeBandToggle}
      /* resolution is fixed to 1m for now — kept as a no-op */
    />
  );
}
