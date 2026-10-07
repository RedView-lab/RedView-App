import type { Map as MapboxMap } from 'mapbox-gl';
import {
  lngLatToTile,
  PREFETCH_MAX_ZOOM,
  PREFETCH_RING,
  PREFETCH_RING_TILTED,
} from './prefetchGeometry';

function getSlopeSource(map: MapboxMap): { tiles?: string[]; maxzoom?: number } | undefined {
  try {
    return map.getStyle()?.sources?.['slope-tiles'] as { tiles?: string[]; maxzoom?: number } | undefined;
  } catch {
    return undefined;
  }
}

function getSlopeTileQuery(map: MapboxMap): string {
  const template = getSlopeSource(map)?.tiles?.[0];
  if (!template) return '';
  const queryStart = template.indexOf('?');
  return queryStart >= 0 ? template.slice(queryStart) : '';
}

/** Deepest zoom the slope source requests (Mapbox overzooms beyond). */
export function getSlopeSourceMaxZoom(map: MapboxMap): number {
  const maxzoom = getSlopeSource(map)?.maxzoom;
  return typeof maxzoom === 'number' && Number.isFinite(maxzoom) ? maxzoom : 16;
}

export function slopePrefetchUrl(map: MapboxMap, z: number, x: number, y: number): string {
  const query = getSlopeTileQuery(map);
  return query
    ? `/slope-tiles/${z}/${x}/${y}${query}&pf=1`
    : `/slope-tiles/${z}/${x}/${y}?pf=1`;
}

/** `demQuery`: '' (surface profile) or 'rv-dem-profile=terrain'. */
export function demPrefetchUrl(z: number, x: number, y: number, demQuery: string): string {
  return `/dem-tiles/${z}/${x}/${y}?${demQuery ? `${demQuery}&` : ''}pf=1`;
}

export interface PrefetchFamilies {
  /** DEM query (see demPrefetchUrl), or null for no DEM prefetch. */
  demQuery: string | null;
  ortho: boolean;
  slope: boolean;
}

/**
 * Construit la liste d'URLs à précharger (DEM, ortho, pentes) pour une boîte englobante et un point d'ancrage.
 * Toutes les familles demandées partagent le zoom `z` : l'appelant fait un appel par zoom
 * (le relief 3D charge son DEM à floor(zoom − 1), l'ortho 256 px à round(zoom)).
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
  families: PrefetchFamilies,
  includeRing: boolean,
  includeChildren: boolean,
  includeParent: boolean,
): string[] {
  const urls: string[] = [];
  const cap = (1 << z) - 1;

  const pushTile = (tileZ: number, tileX: number, tileY: number) => {
    if (families.demQuery !== null) urls.push(demPrefetchUrl(tileZ, tileX, tileY, families.demQuery));
    if (families.ortho && tileZ >= 11) urls.push(`/ortho-tiles/${tileZ}/${tileX}/${tileY}?pf=1`);
    if (families.slope) urls.push(slopePrefetchUrl(map, tileZ, tileX, tileY));
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
        pushTile(z, x, y);
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
      pushTile(z1, t.x, t.y);
    }
  }

  if (includeParent && z > 4) {
    const zM = z - 1;
    const p = lngLatToTile(anchor.lng, anchor.lat, zM);
    const capM = (1 << zM) - 1;
    if (p.x >= 0 && p.y >= 0 && p.x <= capM && p.y <= capM) {
      pushTile(zM, p.x, p.y);
    }
  }

  return urls;
}
