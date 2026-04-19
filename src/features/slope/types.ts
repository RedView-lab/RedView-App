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

/** Slope sampling resolution. '0.40m (LIDAR)' = native LIDAR (no downsampling),
 *  others apply a box-average over the elevation grid before slope computation. */
export type SlopeResolutionKey = '0.40m (LIDAR)' | '1m' | '5m' | '10m';

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
