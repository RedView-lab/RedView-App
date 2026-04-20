/**
 * Terrain shadows — Mapbox hillshade layer driven by the live DEM.
 *
 * The previous implementation projected a precomputed raster mask over the
 * map. In practice that behaved like a global darkening veil on pitched views
 * more often than like relief-aware terrain shadows. We now let Mapbox derive
 * shading directly from the active DEM source so the shadowing follows the
 * terrain model itself.
 */

export const SHADOW_SOURCE_ID = 'shadow-tiles';
export const SHADOW_LAYER_ID = 'shadow-overlay';

const SHADOW_TERRAIN_SOURCE_ID = 'unified-dem';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function formatAlpha(value: number): string {
  return clamp01(value).toFixed(3);
}

export interface ShadowPaintOptions {
  opacity: number;
  sunAzimuthDeg: number;
  sunAltitudeDeg: number;
}

export function buildShadowTileSource(sunAzDeg: number, sunAltDeg: number) {
  const az = sunAzDeg.toFixed(1);
  const alt = sunAltDeg.toFixed(1);
  return {
    type: 'raster' as const,
    tiles: [`/shadow-tiles/{z}/{x}/{y}?az=${az}&alt=${alt}`],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 17,
  };
}

export function buildShadowPaint(opts: ShadowPaintOptions) {
  const opacity = clamp01(opts.opacity);
  const rawSunAltitude = opts.sunAltitudeDeg;
  const sunAltitude = Math.max(0, rawSunAltitude);
  const lowSunFactor = clamp01(1 - sunAltitude / 70);
  const highSunFactor = 1 - lowSunFactor;
  const visibility = smoothstep(-2.5, 4, rawSunAltitude);
  const darkness = clamp01(opacity * visibility * (0.82 + lowSunFactor * 0.18));
  const accent = clamp01(opacity * visibility * (0.28 + lowSunFactor * 0.22));
  const highlight = clamp01(opacity * visibility * (0.01 + highSunFactor * 0.025));

  return {
    'hillshade-illumination-anchor': 'map' as const,
    'hillshade-illumination-direction': ((opts.sunAzimuthDeg % 360) + 360) % 360,
    'hillshade-exaggeration': 0.45 + visibility * (0.35 + lowSunFactor * 0.2),
    'hillshade-shadow-color': `rgba(0, 0, 0, ${formatAlpha(darkness)})`,
    'hillshade-highlight-color': `rgba(255, 246, 225, ${formatAlpha(highlight)})`,
    'hillshade-accent-color': `rgba(16, 28, 48, ${formatAlpha(accent)})`,
  };
}

export function buildShadowLayer(opts: ShadowPaintOptions) {
  return {
    id: SHADOW_LAYER_ID,
    type: 'hillshade' as const,
    source: SHADOW_TERRAIN_SOURCE_ID,
    slot: 'top',
    paint: buildShadowPaint(opts),
  };
}
