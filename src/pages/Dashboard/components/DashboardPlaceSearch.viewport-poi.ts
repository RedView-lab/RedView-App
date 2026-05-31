import type { Map as MapboxMap, Marker } from 'mapbox-gl';

import { fetchPoisInBbox } from '@/features/poi/lib/poi-api';
import { getPoiIconUrl } from '@/features/poi/lib/poi-icons';
import type { PoiCategory, PoiFeature } from '@/features/poi/types';

import { DROPDOWN_VIEWPORT_POI_ICON_URLS } from './DashboardPlaceSearch.constants';
import type {
  ViewportPoiCandidate,
  ViewportPoiLodProfile,
} from './DashboardPlaceSearch.types';

function getDropdownViewportPoiIconUrl(category: PoiCategory): string {
  return DROPDOWN_VIEWPORT_POI_ICON_URLS[category] ?? getPoiIconUrl(category);
}

function getViewportPoiMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

function getViewportPoiMarkerSignature(feature: PoiFeature): string {
  return [feature.category, feature.id, feature.lat, feature.lon].join('|');
}

function getViewportPoiLodProfile(zoom: number): ViewportPoiLodProfile {
  if (zoom < 6.2) {
    return { fetchLimit: 2_400, targetCount: 40, cellPx: 136, maxPerCategory: 8 };
  }
  if (zoom < 7.4) {
    return { fetchLimit: 2_800, targetCount: 56, cellPx: 120, maxPerCategory: 10 };
  }
  if (zoom < 8.8) {
    return { fetchLimit: 3_200, targetCount: 72, cellPx: 104, maxPerCategory: 12 };
  }
  if (zoom < 10.4) {
    return { fetchLimit: 3_800, targetCount: 96, cellPx: 90, maxPerCategory: 16 };
  }
  if (zoom < 12.2) {
    return { fetchLimit: 4_400, targetCount: 132, cellPx: 78, maxPerCategory: 22 };
  }
  return { fetchLimit: 5_200, targetCount: 180, cellPx: 64, maxPerCategory: 30 };
}

function getViewportPoiMarkerSizePx(zoom: number): number {
  if (zoom < 6.2) return 76;
  if (zoom < 7.4) return 72;
  if (zoom < 8.8) return 68;
  if (zoom < 10.4) return 64;
  if (zoom < 12.2) return 60;
  return 56;
}

export function applyViewportPoiMarkerVisualState(marker: Marker, zoom: number): void {
  const sizePx = getViewportPoiMarkerSizePx(zoom);
  marker.getElement().style.setProperty('--rv-dashboard-poi-marker-size', `${sizePx}px`);
}

function rankViewportPoiCandidates(
  map: MapboxMap,
  features: PoiFeature[],
): ViewportPoiCandidate[] {
  const container = map.getContainer();
  const centerX = container.clientWidth / 2;
  const centerY = container.clientHeight / 2;
  const ranked: ViewportPoiCandidate[] = [];

  for (const feature of features) {
    const point = map.project([feature.lon, feature.lat]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    ranked.push({
      feature,
      x: point.x,
      y: point.y,
      centerDistance: Math.sqrt(dx * dx + dy * dy),
    });
  }

  return ranked;
}

export function selectViewportLodPois(
  map: MapboxMap,
  features: PoiFeature[],
  categories: PoiCategory[],
  stickyKeys: ReadonlySet<string> = new Set(),
): PoiFeature[] {
  if (features.length === 0) return [];

  const zoom = map.getZoom();
  const profile = getViewportPoiLodProfile(zoom);
  const cellBuckets = new Map<string, ViewportPoiCandidate>();

  for (const candidate of rankViewportPoiCandidates(map, features)) {
    const cellX = Math.floor(candidate.x / profile.cellPx);
    const cellY = Math.floor(candidate.y / profile.cellPx);
    const key = `${cellX}:${cellY}:${candidate.feature.category}`;
    const existing = cellBuckets.get(key);
    const candidateIsSticky = stickyKeys.has(getViewportPoiMarkerKey(candidate.feature));
    const existingIsSticky = existing
      ? stickyKeys.has(getViewportPoiMarkerKey(existing.feature))
      : false;
    if (
      !existing
      || (candidateIsSticky && !existingIsSticky)
      || (candidateIsSticky === existingIsSticky
        && candidate.centerDistance < existing.centerDistance)
    ) {
      cellBuckets.set(key, candidate);
    }
  }

  const grouped = new Map<PoiCategory, ViewportPoiCandidate[]>();
  for (const candidate of cellBuckets.values()) {
    const list = grouped.get(candidate.feature.category) ?? [];
    list.push(candidate);
    grouped.set(candidate.feature.category, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => {
      const leftSticky = stickyKeys.has(getViewportPoiMarkerKey(left.feature));
      const rightSticky = stickyKeys.has(getViewportPoiMarkerKey(right.feature));
      if (leftSticky !== rightSticky) {
        return leftSticky ? -1 : 1;
      }
      return left.centerDistance - right.centerDistance;
    });
  }

  const activeCategories = categories.filter((category) => (grouped.get(category)?.length ?? 0) > 0);
  const perCategoryCount = new Map<PoiCategory, number>();
  const selected: PoiFeature[] = [];
  const fairnessCategoryCount = Math.max(activeCategories.length, 1);
  const effectivePerCategoryCap = Math.max(
    profile.maxPerCategory,
    Math.ceil(profile.targetCount / fairnessCategoryCount),
  );
  const maxIterations = profile.targetCount * fairnessCategoryCount;
  let iterations = 0;

  while (selected.length < profile.targetCount && iterations < maxIterations) {
    let progressed = false;
    for (const category of activeCategories) {
      if (selected.length >= profile.targetCount) break;
      const bucket = grouped.get(category);
      if (!bucket || bucket.length === 0) continue;
      const used = perCategoryCount.get(category) ?? 0;
      if (used >= effectivePerCategoryCap) continue;
      const next = bucket.shift();
      if (!next) continue;
      selected.push(next.feature);
      perCategoryCount.set(category, used + 1);
      progressed = true;
      if (selected.length >= profile.targetCount) break;
    }
    if (!progressed) break;
    iterations += 1;
  }

  if (selected.length < profile.targetCount) {
    const leftovers = [...grouped.values()]
      .flat()
      .sort((left, right) => left.centerDistance - right.centerDistance);

    for (const candidate of leftovers) {
      if (selected.length >= profile.targetCount) break;
      selected.push(candidate.feature);
    }
  }

  return selected;
}

export function createViewportPoiMarkerElement(feature: PoiFeature): HTMLDivElement {
  const element = document.createElement('div');
  element.style.display = 'inline-flex';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.width = 'var(--rv-dashboard-poi-marker-size, 60px)';
  element.style.height = 'var(--rv-dashboard-poi-marker-size, 60px)';
  element.style.filter = 'drop-shadow(0 0 6px rgba(0,0,0,0.16))';
  element.style.pointerEvents = 'none';

  const image = document.createElement('img');
  image.src = getDropdownViewportPoiIconUrl(feature.category);
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  image.style.display = 'block';
  image.style.width = '100%';
  image.style.height = '100%';

  element.appendChild(image);
  return element;
}

export async function fetchVisibleViewportPois(
  map: MapboxMap,
  categories: PoiCategory[],
  signal: AbortSignal,
): Promise<PoiFeature[]> {
  const bounds = map.getBounds();
  if (!bounds) return [];

  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const limit = getViewportPoiLodProfile(map.getZoom()).fetchLimit;

  if (west <= east) {
    return fetchPoisInBbox(south, west, north, east, categories, signal, limit);
  }

  const [left, right] = await Promise.all([
    fetchPoisInBbox(south, west, north, 180, categories, signal, limit),
    fetchPoisInBbox(south, -180, north, east, categories, signal, limit),
  ]);
  const deduped = new Map<string, PoiFeature>();
  for (const feature of [...left, ...right]) {
    deduped.set(getViewportPoiMarkerKey(feature), feature);
  }
  return [...deduped.values()];
}

export {
  getViewportPoiMarkerKey,
  getViewportPoiMarkerSignature,
};