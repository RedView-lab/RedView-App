import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { getActiveDem3dQuality, subscribeDem3dQuality } from '@/features/map3d/lib/dem3dQualityBus';
import { isThreeDPitch } from '@/features/map3d/lib/viewDimension';
import type { RouteDisplayContext } from '../lib/route-layer/displayQuality';

const isHdTerrain = () => getActiveDem3dQuality() === 'hd';

/**
 * Vue 2D / 3D de la carte (inclinaison, comme le bouton 2D / 3D) et relief HD
 * ou 30 m : ce qui décide de la finesse `auto` des traces. Ne change qu'au
 * passage d'un seuil, pas à chaque image d'une inclinaison.
 */
export function useRouteDisplayContext(map: MapboxMap | null): RouteDisplayContext {
  const subscribePitch = useCallback((onChange: () => void) => {
    if (!map) return () => {};
    map.on('pitch', onChange);
    return () => {
      map.off('pitch', onChange);
    };
  }, [map]);
  const threeD = useSyncExternalStore(subscribePitch, () => (map ? isThreeDPitch(map.getPitch()) : false));
  const hdTerrain = useSyncExternalStore(subscribeDem3dQuality, isHdTerrain);
  return useMemo(() => ({ threeD, hdTerrain }), [threeD, hdTerrain]);
}
