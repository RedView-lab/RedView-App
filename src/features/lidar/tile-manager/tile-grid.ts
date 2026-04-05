import type { TileCoord } from '../types/geometry';
import { fromWgs84, toWgs84, detectAltRef } from '../processing/coord-transform';

const FRANCE_BOUNDS = { west: -5.5, south: 41.0, east: 10.0, north: 51.5 };

export function viewportToTileCoords(
  west: number,
  south: number,
  east: number,
  north: number,
): TileCoord[] {
  const clampedWest = Math.max(west, FRANCE_BOUNDS.west);
  const clampedSouth = Math.max(south, FRANCE_BOUNDS.south);
  const clampedEast = Math.min(east, FRANCE_BOUNDS.east);
  const clampedNorth = Math.min(north, FRANCE_BOUNDS.north);

  if (clampedWest >= clampedEast || clampedSouth >= clampedNorth) return [];

  const [swX, swY] = fromWgs84(clampedWest, clampedSouth, 'LAMB93');
  const [neX, neY] = fromWgs84(clampedEast, clampedNorth, 'LAMB93');

  const minXKm = Math.floor(Math.min(swX, neX) / 1000);
  const maxXKm = Math.floor(Math.max(swX, neX) / 1000);
  const minYKm = Math.floor(Math.min(swY, neY) / 1000);
  const maxYKm = Math.floor(Math.max(swY, neY) / 1000);

  const tiles: TileCoord[] = [];
  for (let y = minYKm; y <= maxYKm; y++) {
    for (let x = minXKm; x <= maxXKm; x++) {
      const altRef = detectAltRef('LAMB93', x * 1000 + 500, y * 1000 + 500);
      tiles.push({
        xKm: x,
        yKm: y,
        territory: 'FXX',
        projection: 'LAMB93',
        altRef,
      });
    }
  }
  return tiles;
}

export function tileToGeoJsonFeature(
  coord: TileCoord,
  status: string,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const x0 = coord.xKm * 1000;
  const y0 = coord.yKm * 1000;
  const x1 = x0 + 1000;
  const y1 = y0 + 1000;

  const [sw_lon, sw_lat] = toWgs84(x0, y0, coord.projection);
  const [se_lon, se_lat] = toWgs84(x1, y0, coord.projection);
  const [ne_lon, ne_lat] = toWgs84(x1, y1, coord.projection);
  const [nw_lon, nw_lat] = toWgs84(x0, y1, coord.projection);

  return {
    type: 'Feature',
    properties: {
      xKm: coord.xKm,
      yKm: coord.yKm,
      territory: coord.territory,
      status,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [sw_lon, sw_lat],
        [se_lon, se_lat],
        [ne_lon, ne_lat],
        [nw_lon, nw_lat],
        [sw_lon, sw_lat],
      ]],
    },
  };
}
