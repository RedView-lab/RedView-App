import { vhrOrthoLayer } from '../../../lib/layers';
import { buildVhrOrthoSource, VHR_ORTHO_SOURCE_ID } from '../../../lib/sources';
import type { Ctx } from './context';

const MAPBOX_SATELLITE_TILESET = 'mapbox://mapbox.satellite';

interface StyleSourceLike {
  url?: string;
}

interface StyleLayerLike {
  id: string;
  type?: string;
  source?: unknown;
}

/**
 * Id of the style layer drawing Mapbox Satellite, or null when the active
 * basemap has no satellite imagery (the overlay is then skipped).
 */
function findSatelliteRasterLayerId(
  layers: readonly StyleLayerLike[],
  sources: Record<string, StyleSourceLike>,
): string | null {
  for (const layer of layers) {
    if (layer.type !== 'raster' || typeof layer.source !== 'string') continue;
    if (sources[layer.source]?.url === MAPBOX_SATELLITE_TILESET) return layer.id;
  }
  return null;
}

/**
 * Very-high-resolution ortho overlay (IGN PCRS / THR, see
 * `buildVhrOrthoSource`) above Mapbox Satellite. Only on basemaps that draw
 * Mapbox Satellite, and only once the Service Worker controls the page:
 * without it /vhr-tiles answers 204 and the overlay would be useless.
 */
export function attachVhrOrtho(ctx: Ctx): void {
  const { map } = ctx;
  const fns = ctx.fns;

  fns.addVhrOrthoOverlay = () => {
    if (!fns.canMutateStyle()) return;
    if (!navigator.serviceWorker?.controller) return;
    try {
      const style = map.getStyle();
      const layers = (style?.layers ?? []) as StyleLayerLike[];
      const sources = (style?.sources ?? {}) as Record<string, StyleSourceLike>;
      const satelliteLayerId = findSatelliteRasterLayerId(layers, sources);
      if (!satelliteLayerId) return;

      if (!map.getSource(VHR_ORTHO_SOURCE_ID)) {
        map.addSource(VHR_ORTHO_SOURCE_ID, buildVhrOrthoSource());
      }
      if (!map.getLayer(vhrOrthoLayer.id)) {
        const satelliteIndex = layers.findIndex((layer) => layer.id === satelliteLayerId);
        const beforeId = layers[satelliteIndex + 1]?.id;
        map.addLayer(vhrOrthoLayer, beforeId);
      }
    } catch (error) {
      console.warn('[map3d] VHR ortho attach failed', error);
    }
  };
}
