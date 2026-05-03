import type { Map as MapboxMap } from 'mapbox-gl';

// ── Slope category definition ─────────────────────────────────────────

export interface SlopeCategory {
  id: string;
  label: string;
  /** Minimum slope angle in degrees (inclusive) */
  minDeg: number;
  /** Maximum slope angle in degrees (exclusive, Infinity for last) */
  maxDeg: number;
  /** Display color (hex) */
  color: string;
  /** Pre-formatted range label as it should appear in the UI legend
   *  (e.g. "0 - 7%", "7% - 12%", "<24%"). Matches Figma node 1749:57744. */
  displayRange: string;
}

// ── Colorization mode ─────────────────────────────────────────────────

export type SlopeColorMode = 'gradient' | 'step';

// ── Persisted user state ──────────────────────────────────────────────

/**
 * Explicit slope calculation source.
 *
 * SURFACE uses the visible LiDAR surface model (MNS / DSM).
 * TERRAIN uses the bare-earth IGN terrain model (MNT / DTM) for slope
 * calculation while keeping the visual LiDAR surface rendering elsewhere.
 */
export type SlopeResolutionKey = '0.40m (LIDAR SURFACE)' | '1m (LIDAR TERRAIN)';

export type SlopeDemProfile = 'default' | 'terrain';

export interface SlopeState {
  enabled: boolean;
  opacity: number;
  colorMode: SlopeColorMode;
  resolution: SlopeResolutionKey;
}

// ── Panel props ───────────────────────────────────────────────────────

export interface SlopePanelProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
}
