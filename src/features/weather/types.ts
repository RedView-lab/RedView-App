import type { Map as MapboxMap } from 'mapbox-gl';

// ── Wind data point returned from Open-Meteo ──────────────────────────

export interface WindPoint {
  lat: number;
  lng: number;
  /** Wind speed in m/s */
  speed: number;
  /** Meteorological wind direction in degrees (0–360, where wind comes FROM) */
  direction: number;
  /** Wind gusts in m/s */
  gusts: number;
}

// ── Grid configuration for viewport sampling ──────────────────────────

export interface WindGridConfig {
  /** Minimum latitude */
  south: number;
  /** Maximum latitude */
  north: number;
  /** Minimum longitude */
  west: number;
  /** Maximum longitude */
  east: number;
  /** Grid spacing in degrees */
  spacing: number;
}

// ── Cache entry for wind data ─────────────────────────────────────────

export interface WindCacheEntry {
  point: WindPoint;
  /** Timestamp (ms) when data was fetched */
  fetchedAt: number;
}

// ── Hook state returned by useWind ────────────────────────────────────

export interface WindState {
  loading: boolean;
  error: string | null;
  pointCount: number;
  lastUpdate: number | null;
}


// ── MapToolsPanel props ───────────────────────────────────────────────

export interface MapToolsPanelProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
}
