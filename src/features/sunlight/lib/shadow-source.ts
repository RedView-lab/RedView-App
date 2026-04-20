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
  const sunAltitude = Math.max(0, opts.sunAltitudeDeg);
  const lowSunFactor = clamp01(1 - sunAltitude / 70);
  const highSunFactor = 1 - lowSunFactor;

  return {
    'hillshade-illumination-anchor': 'map' as const,
    'hillshade-illumination-direction': ((opts.sunAzimuthDeg % 360) + 360) % 360,
    'hillshade-exaggeration': 0.16 + lowSunFactor * 0.94,
    'hillshade-shadow-color': `rgba(6, 12, 22, ${formatAlpha(opacity * (0.22 + lowSunFactor * 0.58))})`,
    'hillshade-highlight-color': `rgba(255, 244, 214, ${formatAlpha(opacity * (0.02 + highSunFactor * 0.08))})`,
    'hillshade-accent-color': `rgba(68, 104, 146, ${formatAlpha(opacity * (0.05 + lowSunFactor * 0.12))})`,
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
