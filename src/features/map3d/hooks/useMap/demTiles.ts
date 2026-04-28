import type { MapSourceDataEvent } from 'mapbox-gl';
import { unifiedDEMSource } from '../../lib/sources';

export type DemSourceDataLike = MapSourceDataEvent & {
  coord?: {
    canonical?: { z: number; x: number; y: number };
    overscaledZ?: number;
    wrap?: number;
  };
  tile?: {
    tileID?: {
      canonical?: { z: number; x: number; y: number };
      overscaledZ?: number;
      wrap?: number;
    };
  };
};

export function getDemTileKey(event: DemSourceDataLike): string | null {
  const directCanonical = event.coord?.canonical;
  if (directCanonical) {
    return `${event.coord?.overscaledZ ?? directCanonical.z}/${directCanonical.x}/${directCanonical.y}/${event.coord?.wrap ?? 0}`;
  }

  const tileId = event.tile?.tileID;
  const tileCanonical = tileId?.canonical;
  if (tileCanonical) {
    return `${tileId?.overscaledZ ?? tileCanonical.z}/${tileCanonical.x}/${tileCanonical.y}/${tileId?.wrap ?? 0}`;
  }

  return null;
}

export function buildDemTilesTemplate(cacheBust: number): string[] {
  if (cacheBust <= 0) return unifiedDEMSource.tiles;
  return unifiedDEMSource.tiles.map((tile) => `${tile}?rv-dem=${cacheBust}`);
}