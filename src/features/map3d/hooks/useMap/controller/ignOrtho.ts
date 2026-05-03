import { ignOrthoLayer } from '../../../lib/layers';
import { ignOrthoSource } from '../../../lib/sources';
import type { Ctx } from './context';

/** Optional IGN ortho overlay (currently disabled by default). */
export function attachIgnOrtho(ctx: Ctx): void {
  const { map } = ctx;
  const fns = ctx.fns;

  fns.addIgnOrthoOverlay = () => {
    if (!fns.canMutateStyle()) return;
    try {
      if (!map.getSource(ignOrthoSource.id)) {
        map.addSource(ignOrthoSource.id, {
          type: 'raster',
          tiles: ignOrthoSource.tiles,
          tileSize: ignOrthoSource.tileSize,
          minzoom: ignOrthoSource.minzoom,
          maxzoom: ignOrthoSource.maxzoom,
          bounds: ignOrthoSource.bounds,
          attribution: ignOrthoSource.attribution,
        });
      }

      if (!map.getLayer(ignOrthoLayer.id)) {
        map.addLayer(ignOrthoLayer);
      }
    } catch (error) {
      console.warn('[map3d] IGN ortho attach failed', error);
    }
  };
}
