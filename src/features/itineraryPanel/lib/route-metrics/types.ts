export interface RoutePointInput {
  lat: number;
  lon: number;
  distanceM?: number;
  elevationM?: number | null;
  gradientPct?: number | null;
  surface?: Surface;
}

export interface RouteProfilePoint {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number;
  gradientPct: number;
  surface?: Surface;
}

export interface RouteMetrics {
  distanceM: number;
  ascentM: number;
  descentM: number;
  avgSlopePercent: number;
  tarmacPercent: number;
  offroadPercent: number;
}

export interface RouteElevationMetrics {
  distanceM: number;
  ascentM: number;
  descentM: number;
  avgSlopePercent: number;
}

export interface RouteSurfaceMetrics {
  distanceM: number;
  tarmacPercent: number;
  offroadPercent: number;
}

export interface ElevationSample {
  lat: number;
  lon: number;
  ele: number;
  distanceM: number;
  gradientPct?: number | null;
}

export type Surface = 'asphalt' | 'paved' | 'gravel' | 'dirt' | 'sand' | 'unknown';

export interface ParsedRow {
  lon: number;
  lat: number;
  ele: number;
  segDistM: number;
  surface: Surface;
}