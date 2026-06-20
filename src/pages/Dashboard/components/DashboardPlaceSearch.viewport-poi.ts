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
  // `fetchLimit` est l'unique paramètre actif : il borne la requête bbox au
  // serveur POI. Les anciens caps de sélection (targetCount / maxPerCategory /
  // cellPx) ont été retirés — voir `selectViewportLodPois` : on affiche
  // désormais TOUS les POI renvoyés, avec un garde-fou de perf uniquement
  // lorsque le count devient pathologique.
  if (zoom < 6.2) {
    return { fetchLimit: 8_000 };
  }
  if (zoom < 7.4) {
    return { fetchLimit: 8_000 };
  }
  if (zoom < 8.8) {
    return { fetchLimit: 9_000 };
  }
  if (zoom < 10.4) {
    return { fetchLimit: 10_000 };
  }
  if (zoom < 12.2) {
    return { fetchLimit: 11_000 };
  }
  return { fetchLimit: 12_000 };
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

/**
 * Nombre de markers DOM au-delà duquel on amorce un amincissement spatial
 * doux pour éviter le lag pathologique (vue pays entière). En-dessous de ce
 * seuil, TOUS les POI renvoyés par le serveur sont affichés sans aucun drop.
 */
const VIEWPORT_POI_PERF_HARD_CAP = 800;

export function selectViewportLodPois(
  map: MapboxMap,
  features: PoiFeature[],
  _categories: PoiCategory[],
  stickyKeys: ReadonlySet<string> = new Set(),
): PoiFeature[] {
  if (features.length === 0) return [];

  // Cas nominal : on est sous le garde-fou de perf → on affiche TOUT.
  // Aucun cell-bucketing, aucun cap par catégorie. Les POI proches de la
  // route (auparavant éliminés par le sélecteur LOD) sont conservés.
  if (features.length <= VIEWPORT_POI_PERF_HARD_CAP) {
    return features.slice().sort((left, right) => {
      const leftId = left.id;
      const rightId = right.id;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  }

  // Garde-fou perf : trop de POI pour le DOM. On amorce un échantillonnage
  // spatial doux via cell-bucketing, mais UNIQUEMENT comme moyen d'amincir
  // (plus de grille fixe par zoom, plus de cap par catégorie). La taille de
  // cellule est calculée dynamiquement pour atterrir près du cap.
  const candidates = rankViewportPoiCandidates(map, features);
  const container = map.getContainer();
  const viewportAreaPx = Math.max(1, container.clientWidth * container.clientHeight);
  // nb de cellules souhaité ≈ cap ; on en déduit la taille de cellule dont
  // l'aire couvre le viewport en ~`cap` cellules.
  const cellAreaPx = Math.max(1, viewportAreaPx / VIEWPORT_POI_PERF_HARD_CAP);
  const cellPx = Math.sqrt(cellAreaPx);

  const cellBuckets = new Map<string, ViewportPoiCandidate>();
  for (const candidate of candidates) {
    const cellX = Math.floor(candidate.x / cellPx);
    const cellY = Math.floor(candidate.y / cellPx);
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

  // Tri final stable : d'abord les sticky (évite le clignotement des POI déjà
  // affichés), puis par distance au centre du viewport.
  const selected = [...cellBuckets.values()].sort((left, right) => {
    const leftSticky = stickyKeys.has(getViewportPoiMarkerKey(left.feature));
    const rightSticky = stickyKeys.has(getViewportPoiMarkerKey(right.feature));
    if (leftSticky !== rightSticky) {
      return leftSticky ? -1 : 1;
    }
    return left.centerDistance - right.centerDistance;
  });

  return selected.map((candidate) => candidate.feature);
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