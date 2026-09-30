import type { Map as MapboxMap, Marker } from 'mapbox-gl';

import { fetchPoisInBbox, type PoiBboxSampling } from '@/features/poi/lib/poi-api';
import { getPoiIconUrl, hasDedicatedFavoritePoiIcon } from '@/features/poi/lib/poi-icons';
import { POI_LABELS, type PoiCategory, type PoiFeature } from '@/features/poi/types';

import { DROPDOWN_VIEWPORT_POI_ICON_URLS } from './DashboardPlaceSearch.constants';
import type { ViewportPoiCandidate } from './DashboardPlaceSearch.types';

function getDropdownViewportPoiIconUrl(category: PoiCategory, favorite?: boolean): string {
  if (favorite) {
    return getPoiIconUrl(category, true);
  }
  return DROPDOWN_VIEWPORT_POI_ICON_URLS[category] ?? getPoiIconUrl(category);
}

function getViewportPoiMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

function getViewportPoiMarkerSignature(feature: PoiFeature): string {
  return [
    feature.category,
    feature.id,
    feature.lat,
    feature.lon,
    feature.favorite ? '1' : '0',
    feature.pauseDurationMin ?? 0,
    feature.tags?.name ?? '',
    feature.name ?? '',
  ].join('|');
}

/**
 * Plafond de POIs demandés au backend par requête bbox. Le serveur échantillonne
 * par cellule (voir `getViewportPoiSampling`), ce plafond ne sert que de
 * garde-fou réseau / parsing JSON.
 */
const VIEWPORT_POI_FETCH_LIMIT = 600;

/**
 * Taille en pixels des icônes de POI selon le zoom.
 * Tailles standards ergonomiques (28px - 36px) pour une netteté parfaite
 * sans masquer les routes ni le relief.
 */
export function getViewportPoiMarkerSizePx(zoom: number): number {
  if (zoom < 8.0) return 24;
  if (zoom < 11.0) return 28;
  if (zoom < 13.0) return 32;
  if (zoom < 15.0) return 34;
  return 36;
}

export function applyViewportPoiMarkerVisualState(marker: Marker, zoom: number): void {
  const sizePx = getViewportPoiMarkerSizePx(zoom);
  marker.getElement().style.setProperty('--rv-dashboard-poi-marker-size', `${sizePx}px`);
}

/**
 * Taille de cellule de grille en pixels pour le bucketing spatial.
 * Plus le zoom est faible, plus les cellules sont larges pour aérer la carte.
 */
function getGridCellSizePx(zoom: number): number {
  if (zoom < 11.0) return 72;
  if (zoom < 13.0) return 56;
  if (zoom < 15.0) return 44;
  return 36;
}

/**
 * Plafond strict du nombre de markers DOM simultanés sur la carte.
 * Garantit un framerate de 60 FPS constant sur terrain 3D sans surcharge CPU.
 */
function getMaxViewportDomMarkers(zoom: number): number {
  if (zoom < 11.0) return 60;
  if (zoom < 13.0) return 65;
  return 85;
}

function getViewportSize(map: MapboxMap): { width: number; height: number } {
  const container = map.getContainer();
  return {
    width: container?.clientWidth || window.innerWidth,
    height: container?.clientHeight || window.innerHeight,
  };
}

/**
 * Cellule effective : jamais plus fine que le plafond DOM ne peut remplir.
 * Sinon, dézoomé, le plafond tronquait une grille trop dense et ne gardait
 * que les POIs proches du centre ; ici les markers restent répartis sur
 * toute la carte.
 */
function getViewportPoiCellPx(map: MapboxMap): number {
  const zoom = map.getZoom();
  const { width, height } = getViewportSize(map);
  const fillCellPx = Math.sqrt((width * height) / getMaxViewportDomMarkers(zoom));
  return Math.max(getGridCellSizePx(zoom), fillCellPx);
}

/**
 * Niveau de tuile XYZ pour l'échantillonnage serveur (un POI par catégorie
 * et par cellule). Mapbox GL : monde = 512 · 2^zoom px, une cellule de niveau
 * L mesure donc 512 · 2^(zoom − L) px. On vise des cellules deux fois plus
 * fines que la grille d'écran pour laisser au tri client (`selectViewportLodPois`)
 * plusieurs candidats par case.
 */
function getViewportPoiSampling(map: MapboxMap): PoiBboxSampling {
  const level = Math.round(map.getZoom() + Math.log2(512 / getViewportPoiCellPx(map))) + 1;
  return { level, perCell: 1 };
}

interface RankedCandidate extends ViewportPoiCandidate {
  key: string;
  isSticky: boolean;
  score: number;
}

/**
 * Sélection LOD intelligente avec anti-collision par grille spatiale et
 * priorité aux POIs qualifiés (sticky > nommé > proche centre).
 */
export function selectViewportLodPois(
  map: MapboxMap,
  features: PoiFeature[],
  _categories: PoiCategory[],
  stickyKeys: ReadonlySet<string> = new Set(),
): PoiFeature[] {
  if (features.length === 0) return [];

  const zoom = map.getZoom();
  const { width, height } = getViewportSize(map);
  const centerX = width / 2;
  const centerY = height / 2;
  const maxCenterDistance = Math.hypot(centerX, centerY) || 1;

  // Marge de débordement légère (30px) pour éviter les apparitions brutales aux bords
  const marginPx = 30;
  const minX = -marginPx;
  const maxX = width + marginPx;
  const minY = -marginPx;
  const maxY = height + marginPx;

  const cellPx = getViewportPoiCellPx(map);
  const maxDomMarkers = getMaxViewportDomMarkers(zoom);

  // 1. Projeter les coordonnées et calculer le score de chaque candidat
  const cellBuckets = new Map<string, RankedCandidate>();

  for (const feature of features) {
    const point = map.project([feature.lon, feature.lat]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;

    // Éliminer les POIs hors viewport visible
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) {
      continue;
    }

    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const centerDistance = Math.hypot(dx, dy);

    const key = getViewportPoiMarkerKey(feature);
    const isSticky = stickyKeys.has(key);
    const hasName = Boolean(
      feature.tags?.name
      || feature.tags?.['name:fr']
      || feature.tags?.['name:en']
      || feature.name
    );

    const isFavorite = Boolean(feature.favorite);
    // Score de qualité :
    // - Favori : +50 000 pts (priorité absolue)
    // - Déjà affiché (sticky) : +1000 pts (anti-flicker lors du pan)
    // - Avec nom identifiable : +200 pts
    // - Proximité au centre du viewport : 0 à +100 pts
    const centerProximityBonus = Math.max(0, (1 - centerDistance / maxCenterDistance) * 100);
    const score = (isFavorite ? 50000 : 0) + (isSticky ? 1000 : 0) + (hasName ? 200 : 0) + centerProximityBonus;

    const candidate: RankedCandidate = {
      feature,
      x: point.x,
      y: point.y,
      centerDistance,
      key,
      isSticky,
      score,
    };

    // Les favoris sont conservés sans jamais être écrasés
    if (isFavorite) {
      cellBuckets.set(`fav:${key}`, candidate);
      continue;
    }

    // 2. Bucketing spatial (1 seul POI non-favori par cellule pixel)
    const cellX = Math.floor(point.x / cellPx);
    const cellY = Math.floor(point.y / cellPx);
    const bucketKey = `${cellX}:${cellY}`;

    const existing = cellBuckets.get(bucketKey);
    if (!existing || candidate.score > existing.score) {
      cellBuckets.set(bucketKey, candidate);
    }
  }

  // 3. Tri et application du plafond avec préservation absolue des favoris
  const allCandidates = [...cellBuckets.values()];
  const favoriteCandidates = allCandidates.filter((c) => c.feature.favorite);
  const regularCandidates = allCandidates.filter((c) => !c.feature.favorite);

  regularCandidates.sort((a, b) => {
    // D'abord les sticky (stabilité visuelle)
    if (a.isSticky !== b.isSticky) {
      return a.isSticky ? -1 : 1;
    }
    // Puis par score décroissant
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Puis par distance au centre croissante
    return a.centerDistance - b.centerDistance;
  });

  const remainingQuota = Math.max(0, maxDomMarkers - favoriteCandidates.length);
  const cappedCandidates = [...favoriteCandidates, ...regularCandidates.slice(0, remainingQuota)];

  // 4. Tri déterministe pour stabilité du cycle de vie React/DOM
  cappedCandidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return cappedCandidates.map((c) => c.feature);
}

export function createViewportPoiMarkerElement(feature: PoiFeature): HTMLButtonElement {
  const isPin = Boolean(feature.favorite);
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `rvd-viewport-poi-marker ${isPin ? 'is-favorite rvd-viewport-poi-marker--pin' : 'rvd-viewport-poi-marker--round'}`;
  element.dataset.poiCategory = feature.category;
  element.style.zIndex = feature.favorite ? '50' : '20';

  const poiName =
    feature.tags?.name
    || feature.tags?.['name:fr']
    || feature.tags?.['name:en']
    || feature.name
    || POI_LABELS[feature.category]
    || feature.category;

  element.title = poiName;
  element.setAttribute(
    'aria-label',
    feature.name?.trim() || feature.tags?.name
      ? `${poiName} - ${POI_LABELS[feature.category] ?? feature.category}`
      : POI_LABELS[feature.category] ?? feature.category,
  );

  const image = document.createElement('img');
  image.className = 'rvd-viewport-poi-marker__img';
  image.src = getDropdownViewportPoiIconUrl(feature.category, feature.favorite === true);
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  element.appendChild(image);

  if (feature.favorite && !hasDedicatedFavoritePoiIcon(feature.category)) {
    const badge = document.createElement('span');
    badge.className = 'rvd-viewport-poi-marker__fav-badge';
    badge.setAttribute('aria-hidden', 'true');
    const badgeIcon = document.createElement('img');
    badgeIcon.className = 'rvd-viewport-poi-marker__fav-icon';
    badgeIcon.src = '/svgv2/icone/star-01.svg';
    badgeIcon.alt = '';
    badge.appendChild(badgeIcon);
    element.appendChild(badge);
  }

  // Symbol with pause time for POIs associated with pauses
  if (feature.pauseDurationMin && feature.pauseDurationMin > 0) {
    const pauseBadge = document.createElement('span');
    pauseBadge.className = 'rvd-viewport-poi-marker__pause-badge';
    pauseBadge.setAttribute('aria-label', `Pause ${feature.pauseDurationMin} min`);
    pauseBadge.innerHTML = `<span class="rvd-viewport-poi-marker__pause-symbol" aria-hidden="true">❚❚</span><span class="rvd-viewport-poi-marker__pause-duration">${feature.pauseDurationMin} min</span>`;
    element.appendChild(pauseBadge);
  }

  element.addEventListener('mouseenter', () => {
    element.style.zIndex = '100';
  });
  element.addEventListener('mouseleave', () => {
    element.style.zIndex = feature.favorite ? '50' : '20';
  });

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
  const limit = VIEWPORT_POI_FETCH_LIMIT;
  const sampling = getViewportPoiSampling(map);

  if (west <= east) {
    return fetchPoisInBbox(south, west, north, east, categories, signal, limit, sampling);
  }

  const [left, right] = await Promise.all([
    fetchPoisInBbox(south, west, north, 180, categories, signal, limit, sampling),
    fetchPoisInBbox(south, -180, north, east, categories, signal, limit, sampling),
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