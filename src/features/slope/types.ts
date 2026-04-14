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
}

// ── Colorization mode ─────────────────────────────────────────────────

export type SlopeColorMode = 'gradient' | 'step';

// ── Persisted user state ──────────────────────────────────────────────

export interface SlopeState {
  enabled: boolean;
  opacity: number;
  colorMode: SlopeColorMode;
}

// ── Panel props ───────────────────────────────────────────────────────

export interface SlopePanelProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
}
