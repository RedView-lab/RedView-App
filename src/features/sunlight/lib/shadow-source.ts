/**
 * Terrain shadows — service-worker generated cast-shadow raster draped over
 * the live terrain.
 *
 * The SW computes real shadow masks from the DEM and current sun angle. This
 * is a true terrain shadow pipeline, unlike hillshade which is only a local
 * relief approximation.
 */

export const SHADOW_SOURCE_ID = 'shadow-tiles';
export const SHADOW_LAYER_ID = 'shadow-overlay';

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
  const visibility = smoothstep(-2.5, 4, rawSunAltitude);
  const darkness = clamp01(opacity * visibility);
  const penumbra = clamp01(opacity * visibility * 0.72);

  return {
    'raster-opacity': 1,
    'raster-resampling': 'linear' as const,
    'raster-fade-duration': 100,
    'raster-color-mix': [1, 0, 0, 0] as [number, number, number, number],
    'raster-color-range': [0, 1] as [number, number],
    'raster-color': [
      'interpolate',
      ['linear'],
      ['raster-value'],
      0, 'rgba(0, 0, 0, 0)',
      0.08, 'rgba(0, 0, 0, 0)',
      0.28, `rgba(0, 0, 0, ${formatAlpha(penumbra * 0.42)})`,
      0.55, `rgba(0, 0, 0, ${formatAlpha(penumbra)})`,
      1, `rgba(0, 0, 0, ${formatAlpha(darkness)})`,
    ] as const,
  };
}

export function buildShadowLayer(opts: ShadowPaintOptions) {
  return {
    id: SHADOW_LAYER_ID,
    type: 'raster' as const,
    source: SHADOW_SOURCE_ID,
    slot: 'top',
    paint: buildShadowPaint(opts),
  };
}
