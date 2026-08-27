import type { Map as MapboxMap } from 'mapbox-gl';
import {
  lngLatToTile,
  PREFETCH_MAX_ZOOM,
  PREFETCH_RING,
  PREFETCH_RING_TILTED,
} from './prefetchGeometry';

export function getSlopeTileQuery(map: MapboxMap): string {
  try {
    const source = map.getStyle()?.sources?.['slope-tiles'] as { tiles?: string[] } | undefined;
    const template = source?.tiles?.[0];
    if (!template) return '';
    const queryStart = template.indexOf('?');
    return queryStart >= 0 ? template.slice(queryStart) : '';
  } catch {
    return '';
  }
}

export function slopePrefetchUrl(map: MapboxMap, z: number, x: number, y: number): string {
  const query = getSlopeTileQuery(map);
  return query
    ? `/slope-tiles/${z}/${x}/${y}${query}&pf=1`
    : `/slope-tiles/${z}/${x}/${y}?pf=1`;
}

/**
 * Construit la liste d'URLs à précharger (DEM, ortho, overlays) pour une boîte englobante et un point d'ancrage.
 */
export function buildPrefetchUrls(
  map: MapboxMap,
  z: number,
  bboxXMin: number,
  bboxYMin: number,
  bboxXMax: number,
  bboxYMax: number,
  anchor: { lng: number; lat: number },
  tilted: boolean,
  orthoOn: boolean,
  includeRing: boolean,
  includeChildren: boolean,
  includeParent: boolean,
  slopeOn: boolean = false,
  altitudeOn: boolean = false,
): string[] {
  const urls: string[] = [];
  const cap = (1 << z) - 1;

  const pushDerived = (tileZ: number, tileX: number, tileY: number) => {
    if (slopeOn) urls.push(slopePrefetchUrl(map, tileZ, tileX, tileY));
    if (altitudeOn) urls.push(`/altitude-tiles/${tileZ}/${tileX}/${tileY}?pf=1`);
  };

  if (includeRing) {
    const ring = tilted ? PREFETCH_RING_TILTED : PREFETCH_RING;
    const rxMin = Math.max(0, bboxXMin - ring);
    const rxMax = Math.min(cap, bboxXMax + ring);
    const ryMin = Math.max(0, bboxYMin - ring);
    const ryMax = Math.min(cap, bboxYMax + ring);
    for (let x = rxMin; x <= rxMax; x++) {
      for (let y = ryMin; y <= ryMax; y++) {
        if (x >= bboxXMin && x <= bboxXMax && y >= bboxYMin && y <= bboxYMax) continue;
        urls.push(`/dem-tiles/${z}/${x}/${y}?pf=1`);
        if (orthoOn && z >= 11) urls.push(`/ortho-tiles/${z}/${x}/${y}?pf=1`);
        pushDerived(z, x, y);
      }
    }
  }

  if (includeChildren && z < PREFETCH_MAX_ZOOM) {
    const z1 = z + 1;
    const c = lngLatToTile(anchor.lng, anchor.lat, z1);
    const cap1 = (1 << z1) - 1;
    const candidates: Array<{ x: number; y: number }> = [
      { x: c.x, y: c.y },
      { x: c.x + 1, y: c.y },
      { x: c.x, y: c.y + 1 },
      { x: c.x + 1, y: c.y + 1 },
    ];
    if (tilted) {
      candidates.push({ x: c.x - 1, y: c.y });
      candidates.push({ x: c.x - 1, y: c.y + 1 });
    }
    for (const t of candidates) {
      if (t.x < 0 || t.y < 0 || t.x > cap1 || t.y > cap1) continue;
      urls.push(`/dem-tiles/${z1}/${t.x}/${t.y}?pf=1`);
      if (orthoOn && z1 >= 11) urls.push(`/ortho-tiles/${z1}/${t.x}/${t.y}?pf=1`);
      pushDerived(z1, t.x, t.y);
    }
  }

  if (includeParent && z > 4) {
    const zM = z - 1;
    const p = lngLatToTile(anchor.lng, anchor.lat, zM);
    const capM = (1 << zM) - 1;
    if (p.x >= 0 && p.y >= 0 && p.x <= capM && p.y <= capM) {
      urls.push(`/dem-tiles/${zM}/${p.x}/${p.y}?pf=1`);
      if (orthoOn && zM >= 11) urls.push(`/ortho-tiles/${zM}/${p.x}/${p.y}?pf=1`);
      pushDerived(zM, p.x, p.y);
    }
  }

  return urls;
}
