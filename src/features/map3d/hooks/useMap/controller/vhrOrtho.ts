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
 * Identifiant du calque de style qui dessine Mapbox Satellite, ou null quand
 * le fond actif n'a pas d'imagerie satellite (l'overlay est alors sauté).
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
 * Overlay d'ortho à très haute résolution (IGN PCRS / THR, voir
 * `buildVhrOrthoSource`) au-dessus de Mapbox Satellite. Seulement sur les fonds
 * qui dessinent Mapbox Satellite, et seulement une fois que le Service Worker
 * contrôle la page : sans lui, /vhr-tiles répond 204 et l'overlay serait inutile.
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
