import type { DemTileProfile } from '../hooks/useMap/demTiles';
import type { Dem3dQuality } from './dem3dQualityBus';

export type Dem3dSelectionId = 'slow-040' | 'terrain-1m' | 'fast-30m';

export interface Dem3dSelectionState {
  quality: Dem3dQuality;
  profile: DemTileProfile;
}

export function resolveDem3dSelection(
  value: string | null | undefined,
): Dem3dSelectionState {
  switch (value) {
    case 'terrain-1m':
      return { quality: 'hd', profile: 'terrain' };
    case 'fast-30m':
      return { quality: 'fast-30m', profile: 'default' };
    default:
      return { quality: 'hd', profile: 'default' };
  }
}