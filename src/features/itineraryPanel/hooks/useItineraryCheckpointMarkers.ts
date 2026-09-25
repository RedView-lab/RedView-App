import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { ItineraryProject } from '../types';
import { translateAppText } from '@/shared/i18n';
import { cumulativeRouteLengthsM, type RouteDistancePoint } from '../lib/routes';
import { writeTracePointDataset } from '../lib/tracer/tracePointDataset';
import { buildScheduledTimelineState, parseStartReference } from '../sections/timeline/TimelineTimelineView/utils';

interface UseItineraryCheckpointMarkersArgs {
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
  isMapLoaded: boolean;
  routesEnabled?: boolean;
  pausesEnabled?: boolean;
  waypointsEnabled?: boolean;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onDeletePause?: (id: string) => void;
  onTogglePauseFavorite?: (id: string, favorite: boolean) => void;
  onDeleteWaypoint?: (id: string) => void;
  onToggleWaypointFavorite?: (id: string, favorite: boolean) => void;
}

interface CheckpointData {
  key: string;
  kind: 'start' | 'end' | 'pause' | 'waypoint';
  coord: [number, number];
  label: string;
  itineraryId: string;
  signature: string;
  pauseId?: string;
  waypointId?: string;
  /** Id de la ligne de timeline portée par ce marqueur (départ / arrivée / waypoint). */
  rowId?: string;
  durationMin?: number | null;
  distanceKm?: number | null;
  favorite?: boolean;
}

interface MarkerRegistryEntry {
  marker: mapboxgl.Marker;
  popup?: mapboxgl.Popup;
  signature: string;
  element: HTMLElement;
  kind: 'start' | 'end' | 'pause' | 'waypoint';
  spreadOffsetPx?: number;
}

interface PausePopupState {
  favoriteEnabled: boolean;
  pauseDurationMin: number;
  isDurationDropdownOpen: boolean;
}

const CHECKPOINT_START_ICON = '/svgv2/icone/checkpoint-start.svg';
const CHECKPOINT_END_ICON = '/svgv2/icone/checkpoint-end.svg';
const CHECKPOINT_PAUSE_ICON = '/svgv2/icone/checkpoint-pause.svg';
const CHECKPOINT_WAYPOINT_ICON = '/svgv2/icone/checkpoint-waypoint.svg';

const UI_ICON_URLS = {
  star: '/svgv2/icone/star-01.svg',
  globe: '/right-click-icons/globe-06.svg',
  chevron: '/svgv2/icone/chevron-down.svg',
  check: '/svgv2/icone/check.svg',
  trash: '/right-click-icons/trash-01.svg',
  pausePin: '/svgv2/icone/checkpoint-pause.svg',
} as const;

const PAUSE_DURATION_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;

const MARKER_MIN_SCALE_ZOOM = 8.25;
const MARKER_MAX_SCALE_ZOOM = 15.1;
const MARKER_MIN_SCREEN_SCALE = 0.42;
const MARKER_MAX_SCREEN_SCALE = 1.0;
const MARKER_MIN_POPUP_OFFSET_PX = 38;
const MARKER_MAX_POPUP_OFFSET_PX = 80;
const CHECKPOINT_MIN_ZOOM = 8.0;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function getPoiMarkerVisualState(zoom: number): { scale: number; popupOffsetPx: number } {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  return {
    scale: lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress),
    popupOffsetPx: Math.round(
      lerp(MARKER_MIN_POPUP_OFFSET_PX, MARKER_MAX_POPUP_OFFSET_PX, progress),
    ),
  };
}

function applyCheckpointZoomVisibility(element: HTMLElement, zoom: number): void {
  if (zoom < CHECKPOINT_MIN_ZOOM) {
    element.style.display = 'none';
    return;
  }
  element.style.display = '';
  const progress = Math.max(0, Math.min(1, (zoom - CHECKPOINT_MIN_ZOOM) / 6.0));
  const scale = 0.6 + progress * 0.4;
  element.style.setProperty('--rv-checkpoint-scale', scale.toFixed(3));
}

function applyMarkerVisualState(entry: MarkerRegistryEntry, zoom: number): void {
  const el = entry.element;
  if (zoom < 8.0) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';

  if (entry.kind === 'pause' || entry.kind === 'waypoint') {
    const visual = getPoiMarkerVisualState(zoom);
    el.style.setProperty('--rv-poi-marker-scale', visual.scale.toFixed(3));
    const spreadPx = entry.spreadOffsetPx ?? 0;
    const scaledSpreadPx = Math.round(spreadPx * visual.scale);
    el.style.setProperty('--rv-poi-spread-x', `${scaledSpreadPx}px`);
    if (entry.popup) {
      entry.popup.setOffset([scaledSpreadPx, visual.popupOffsetPx]);
    }
  } else {
    applyCheckpointZoomVisibility(el, zoom);
  }
}

function computeCheckpointSpreadOffsets(checkpoints: CheckpointData[]): Map<string, number> {
  const offsetMap = new Map<string, number>();
  if (checkpoints.length === 0) return offsetMap;

  const clusters: CheckpointData[][] = [];
  for (const cp of checkpoints) {
    let targetCluster: CheckpointData[] | null = null;
    for (const cluster of clusters) {
      const anchor = cluster[0];
      const dLat = (cp.coord[1] - anchor.coord[1]) * 111320;
      const dLon =
        (cp.coord[0] - anchor.coord[0]) *
        111320 *
        Math.cos(((cp.coord[1] + anchor.coord[1]) / 2) * (Math.PI / 180));
      const distM = Math.hypot(dLat, dLon);
      if (distM <= 18) {
        targetCluster = cluster;
        break;
      }
    }
    if (targetCluster) {
      targetCluster.push(cp);
    } else {
      clusters.push([cp]);
    }
  }

  for (const cluster of clusters) {
    const N = cluster.length;
    if (N <= 1) {
      offsetMap.set(cluster[0].key, 0);
      continue;
    }

    // Sort so non-favorites are first, favorites last (rendered on top)
    cluster.sort((a, b) => {
      if (Boolean(a.favorite) !== Boolean(b.favorite)) {
        return a.favorite ? 1 : -1;
      }
      return 0;
    });

    cluster.forEach((cp, idx) => {
      const centerOffset = idx - (N - 1) / 2;
      offsetMap.set(cp.key, Math.round(centerOffset * 26));
    });
  }

  return offsetMap;
}

function getRoutePointDistances(points: Array<{ lat: number; lon: number; distanceM?: number }>): number[] {
  if (points.length === 0) return [];
  const hasEmbedded = points.every(
    (p) => typeof p.distanceM === 'number' && Number.isFinite(p.distanceM),
  );
  if (hasEmbedded) {
    return points.map((p) => p.distanceM as number);
  }
  return cumulativeRouteLengthsM(points);
}

function interpolateRoutePointAtDistanceM(
  routePoints: RouteDistancePoint[],
  distancesM: number[],
  targetDistanceM: number,
): { lat: number; lon: number } | null {
  if (routePoints.length === 0 || distancesM.length === 0) return null;
  if (routePoints.length === 1) return { lat: routePoints[0].lat, lon: routePoints[0].lon };

  const totalM = distancesM[distancesM.length - 1] ?? 0;
  const clampedM = Math.max(0, Math.min(totalM, targetDistanceM));

  if (clampedM <= (distancesM[0] ?? 0)) {
    return { lat: routePoints[0].lat, lon: routePoints[0].lon };
  }
  if (clampedM >= totalM) {
    const last = routePoints[routePoints.length - 1];
    return { lat: last.lat, lon: last.lon };
  }

  let lo = 0;
  let hi = routePoints.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((distancesM[mid] ?? 0) <= clampedM) lo = mid;
    else hi = mid;
  }

  const segStartM = distancesM[lo] ?? 0;
  const segEndM = distancesM[hi] ?? segStartM;
  const segSpanM = segEndM - segStartM;
  const t = segSpanM > 0 ? (clampedM - segStartM) / segSpanM : 0;

  const startPt = routePoints[lo];
  const endPt = routePoints[hi];
  return {
    lat: startPt.lat + (endPt.lat - startPt.lat) * t,
    lon: startPt.lon + (endPt.lon - startPt.lon) * t,
  };
}

function buildPausePopupHtml(title: string, state: PausePopupState): string {
  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <button
          type="button"
          class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost${state.favoriteEnabled ? ' is-active' : ''}"
          aria-label="${translateAppText('Favori')}"
          aria-pressed="${state.favoriteEnabled}"
          data-action="favorite-toggle"
        >
          <img src="${UI_ICON_URLS.star}" alt="" class="rv-poi-popup__icon rv-poi-popup__icon--star" />
        </button>
        <div class="rv-poi-popup__title">${escapeHtml(title)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="${translateAppText('Fermer')}" data-action="close">
          <img src="${UI_ICON_URLS.globe}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">${translateAppText('Type')}</div>
        <div class="rv-poi-popup__select" aria-label="${translateAppText('Type de POI')}" role="presentation">
          <span class="rv-poi-popup__type-icon-wrap">
            <img src="${UI_ICON_URLS.pausePin}" alt="" class="rv-poi-popup__type-icon" />
          </span>
          <span class="rv-poi-popup__select-value">${translateAppText('Pause')}</span>
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">${translateAppText('Durée')}</div>
        <div class="rv-poi-popup__select-wrap">
          <button
            type="button"
            class="rv-poi-popup__select rv-poi-popup__select--duration"
            aria-label="${translateAppText('Durée de pause')}"
            data-action="pause-duration"
            aria-haspopup="listbox"
            aria-expanded="${state.isDurationDropdownOpen === true}"
          >
            <span class="rv-poi-popup__select-value">${state.pauseDurationMin} min</span>
            <img src="${UI_ICON_URLS.chevron}" alt="" class="rv-poi-popup__chevron" />
          </button>
          ${
            state.isDurationDropdownOpen
              ? `
            <div class="rvc-select__dropdown rv-poi-popup__dropdown" role="listbox" aria-label="${translateAppText('Durée de pause')}">
              <div class="rv-poi-popup__dropdown-list">
                ${PAUSE_DURATION_OPTIONS.map((dur) => {
                  const selected = dur === state.pauseDurationMin;
                  return `
                    <div
                      class="rvc-select__option rv-poi-popup__dropdown-option${selected ? ' is-selected' : ''}"
                      role="option"
                      data-duration="${dur}"
                      aria-selected="${selected}"
                    >
                      <span class="rvc-select__option-label rv-poi-popup__dropdown-text">${dur} min</span>
                      ${selected ? `<img src="${UI_ICON_URLS.check}" alt="" class="rvc-select__option-check rv-poi-popup__dropdown-check" />` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `
              : ''
          }
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__action-row rv-poi-popup__action-row--delete" data-action="delete">
        <span class="rv-poi-popup__utility-icon-wrap">
          <img src="${UI_ICON_URLS.trash}" alt="" class="rv-poi-popup__utility-icon" />
        </span>
        <span class="rv-poi-popup__action-label rv-poi-popup__action-label--delete">${translateAppText('Supprimer')}</span>
      </button>
    </div>
  `;
}

function buildWaypointPopupHtml(title: string, state: { favoriteEnabled: boolean }): string {
  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <button
          type="button"
          class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost${state.favoriteEnabled ? ' is-active' : ''}"
          aria-label="${translateAppText('Favori')}"
          aria-pressed="${state.favoriteEnabled}"
          data-action="favorite-toggle"
        >
          <img src="${UI_ICON_URLS.star}" alt="" class="rv-poi-popup__icon rv-poi-popup__icon--star" />
        </button>
        <div class="rv-poi-popup__title">${escapeHtml(title)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="${translateAppText('Fermer')}" data-action="close">
          <img src="${UI_ICON_URLS.globe}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">${translateAppText('Type')}</div>
        <div class="rv-poi-popup__select" aria-label="${translateAppText('Type de POI')}" role="presentation">
          <span class="rv-poi-popup__type-icon-wrap">
            <img src="${CHECKPOINT_WAYPOINT_ICON}" alt="" class="rv-poi-popup__type-icon" />
          </span>
          <span class="rv-poi-popup__select-value">${translateAppText('Waypoint')}</span>
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__action-row rv-poi-popup__action-row--delete" data-action="delete">
        <span class="rv-poi-popup__utility-icon-wrap">
          <img src="${UI_ICON_URLS.trash}" alt="" class="rv-poi-popup__utility-icon" />
        </span>
        <span class="rv-poi-popup__action-label rv-poi-popup__action-label--delete">${translateAppText('Supprimer')}</span>
      </button>
    </div>
  `;
}

function createPausePopup(
  pauseId: string,
  label: string,
  initialDurationMin: number,
  initialFavorite: boolean,
  callbacks: {
    onChangeDuration?: (id: string, durationMin: number) => void;
    onDelete?: (id: string) => void;
    onToggleFavorite?: (id: string, favorite: boolean) => void;
  },
): mapboxgl.Popup {
  const popup = new mapboxgl.Popup({
    className: 'rv-poi-popup',
    closeButton: false,
    closeOnClick: true,
    focusAfterOpen: false,
    maxWidth: 'none',
    offset: MARKER_MAX_POPUP_OFFSET_PX,
  });

  const state: PausePopupState = {
    favoriteEnabled: initialFavorite,
    pauseDurationMin: initialDurationMin || 15,
    isDurationDropdownOpen: false,
  };

  const container = document.createElement('div');

  const refresh = () => {
    container.innerHTML = buildPausePopupHtml(label || translateAppText('Pause'), state);
    const panel = container.firstElementChild;
    if (!panel) return;

    panel.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popup.remove();
    });

    panel.querySelector('[data-action="favorite-toggle"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.favoriteEnabled = !state.favoriteEnabled;
      state.isDurationDropdownOpen = false;
      callbacks.onToggleFavorite?.(pauseId, state.favoriteEnabled);
      refresh();
    });

    panel.querySelector('[data-action="pause-duration"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.isDurationDropdownOpen = !state.isDurationDropdownOpen;
      refresh();
    });

    for (const opt of panel.querySelectorAll<HTMLDivElement>('.rv-poi-popup__dropdown-option')) {
      opt.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dur = Number(opt.dataset.duration);
        if (Number.isFinite(dur)) {
          state.pauseDurationMin = dur;
          state.isDurationDropdownOpen = false;
          callbacks.onChangeDuration?.(pauseId, dur);
          refresh();
        }
      });
    }

    panel.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popup.remove();
      callbacks.onDelete?.(pauseId);
    });
  };

  refresh();
  popup.on('open', () => refresh());
  popup.setDOMContent(container);
  return popup;
}

function createWaypointPopup(
  waypointId: string,
  label: string,
  initialFavorite: boolean,
  callbacks: {
    onDelete?: (id: string) => void;
    onToggleFavorite?: (id: string, favorite: boolean) => void;
  },
): mapboxgl.Popup {
  const popup = new mapboxgl.Popup({
    className: 'rv-poi-popup',
    closeButton: false,
    closeOnClick: true,
    focusAfterOpen: false,
    maxWidth: 'none',
    offset: MARKER_MAX_POPUP_OFFSET_PX,
  });

  const state = {
    favoriteEnabled: initialFavorite,
  };

  const container = document.createElement('div');

  const refresh = () => {
    container.innerHTML = buildWaypointPopupHtml(label || translateAppText('Waypoint'), state);
    const panel = container.firstElementChild;
    if (!panel) return;

    panel.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popup.remove();
    });

    panel.querySelector('[data-action="favorite-toggle"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.favoriteEnabled = !state.favoriteEnabled;
      callbacks.onToggleFavorite?.(waypointId, state.favoriteEnabled);
      refresh();
    });

    panel.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popup.remove();
      callbacks.onDelete?.(waypointId);
    });
  };

  refresh();
  popup.on('open', () => refresh());
  popup.setDOMContent(container);
  return popup;
}

function createMarkerElement(
  kind: 'start' | 'end' | 'pause' | 'waypoint',
  label: string,
  durationMin?: number | null,
  distanceKm?: number | null,
  favorite?: boolean,
): HTMLElement {
  if (kind === 'pause' || kind === 'waypoint') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `rv-poi-marker rv-poi-marker--${kind}${favorite ? ' is-favorite rv-poi-marker--favorite' : ''}`;
    el.style.zIndex = favorite ? '50' : '20';

    const kindName = kind === 'pause' ? translateAppText('Pause') : translateAppText('Waypoint');
    const durSuffix = kind === 'pause' && durationMin ? ` · ${durationMin} min` : '';
    const distSuffix = distanceKm != null && distanceKm > 0 ? ` (${distanceKm.toFixed(1)} km)` : '';
    const favSuffix = favorite ? ` ★` : '';
    const title =
      label && label !== 'Pause' && label !== 'Waypoint'
        ? `${label}${durSuffix}${distSuffix}${favSuffix}`
        : `${kindName}${durSuffix}${distSuffix}${favSuffix}`;
    el.title = title;
    el.setAttribute('aria-label', title);

    const inner = document.createElement('div');
    inner.className = 'rv-poi-marker__inner';

    const img = document.createElement('img');
    img.className = 'rv-poi-marker__img';
    img.src = kind === 'pause' ? CHECKPOINT_PAUSE_ICON : CHECKPOINT_WAYPOINT_ICON;
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    inner.appendChild(img);

    if (favorite) {
      const badge = document.createElement('span');
      badge.className = 'rv-poi-marker__favorite-badge';
      badge.setAttribute('aria-hidden', 'true');

      const badgeIcon = document.createElement('img');
      badgeIcon.className = 'rv-poi-marker__favorite-badge-icon';
      badgeIcon.src = UI_ICON_URLS.star;
      badgeIcon.alt = '';
      badgeIcon.draggable = false;
      badge.appendChild(badgeIcon);

      inner.appendChild(badge);
    }

    el.appendChild(inner);

    el.addEventListener('mouseenter', () => {
      el.style.zIndex = '100';
    });
    el.addEventListener('mouseleave', () => {
      el.style.zIndex = favorite ? '50' : '20';
    });

    return el;
  }

  const el = document.createElement('div');
  el.className = `rv-checkpoint-marker rv-checkpoint-marker--${kind}`;

  const kindName = kind === 'start' ? translateAppText('Départ') : translateAppText('Arrivée');
  const distSuffix = distanceKm != null && distanceKm > 0 ? ` (${distanceKm.toFixed(1)} km)` : '';
  const title = label ? `${kindName} : ${label}${distSuffix}` : `${kindName}${distSuffix}`;
  el.title = title;
  el.setAttribute('aria-label', title);

  const img = document.createElement('img');
  img.className = 'rv-checkpoint-marker__img';
  img.src = kind === 'start' ? CHECKPOINT_START_ICON : CHECKPOINT_END_ICON;
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  el.appendChild(img);

  return el;
}

/**
 * Expose sur l'élément du marqueur de quoi l'identifier depuis un handler DOM
 * générique (utilisé par le drag & drop de l'outil Tracer). Les pauses sont
 * exclues : elles sont positionnées par distance le long du tracé, pas par
 * coordonnées libres.
 */
function applyTracePointDataset(element: HTMLElement, cp: CheckpointData): void {
  if (cp.kind === 'pause' || !cp.rowId) return;

  writeTracePointDataset(element.dataset, {
    itineraryId: cp.itineraryId,
    rowId: cp.rowId,
    kind: cp.kind,
    lon: cp.coord[0],
    lat: cp.coord[1],
  });
}

export function useItineraryCheckpointMarkers({
  itineraries,
  map,
  isMapLoaded,
  routesEnabled = true,
  pausesEnabled = true,
  waypointsEnabled = true,
  onChangePauseDuration,
  onDeletePause,
  onTogglePauseFavorite,
  onDeleteWaypoint,
  onToggleWaypointFavorite,
}: UseItineraryCheckpointMarkersArgs): void {
  const registryRef = useRef<Map<string, MarkerRegistryEntry>>(new Map());

  // Keep latest callbacks in ref for stable popup handlers
  const callbacksRef = useRef({
    onChangePauseDuration,
    onDeletePause,
    onTogglePauseFavorite,
    onDeleteWaypoint,
    onToggleWaypointFavorite,
  });

  useEffect(() => {
    callbacksRef.current = {
      onChangePauseDuration,
      onDeletePause,
      onTogglePauseFavorite,
      onDeleteWaypoint,
      onToggleWaypointFavorite,
    };
  }, [
    onChangePauseDuration,
    onDeletePause,
    onTogglePauseFavorite,
    onDeleteWaypoint,
    onToggleWaypointFavorite,
  ]);

  useEffect(() => {
    const registry = registryRef.current;
    if (!map || !isMapLoaded || !routesEnabled) {
      registry.forEach((entry) => entry.marker.remove());
      registry.clear();
      return;
    }

    const currentZoom = map.getZoom();
    const currentCheckpoints: CheckpointData[] = [];

    for (const itinerary of itineraries) {
      if (itinerary.visible === false) continue;

      const routePoints: RouteDistancePoint[] = itinerary.gpxRoute?.points ?? [];
      const distancesM = getRoutePointDistances(routePoints);

      // 1. Start checkpoint
      let startCoord: [number, number] | null = null;
      let startLabel = '';
      const startRow = itinerary.timeline.find((row) => row.kind === 'start');
      if (startRow && startRow.lat != null && startRow.lon != null) {
        startCoord = [startRow.lon, startRow.lat];
        startLabel = startRow.label ?? '';
      } else if (routePoints.length > 0) {
        const firstPt = routePoints[0];
        startCoord = [firstPt.lon, firstPt.lat];
        startLabel = startRow?.label ?? '';
      }

      if (startCoord) {
        const key = `${itinerary.id}:start`;
        const signature = `${key}:${startCoord[0].toFixed(6)},${startCoord[1].toFixed(6)}:${startLabel}`;
        currentCheckpoints.push({
          key,
          kind: 'start',
          coord: startCoord,
          label: startLabel,
          itineraryId: itinerary.id,
          signature,
          rowId: startRow?.id,
          distanceKm: 0,
        });
      }

      // 2. End checkpoint
      let endCoord: [number, number] | null = null;
      let endLabel = '';
      const endRow = itinerary.timeline.find((row) => row.kind === 'end');
      if (endRow && endRow.lat != null && endRow.lon != null) {
        endCoord = [endRow.lon, endRow.lat];
        endLabel = endRow.label ?? '';
      } else if (routePoints.length >= 2) {
        const lastPt = routePoints[routePoints.length - 1];
        endCoord = [lastPt.lon, lastPt.lat];
        endLabel = endRow?.label ?? '';
      }

      if (endCoord) {
        const key = `${itinerary.id}:end`;
        const signature = `${key}:${endCoord[0].toFixed(6)},${endCoord[1].toFixed(6)}:${endLabel}`;
        currentCheckpoints.push({
          key,
          kind: 'end',
          coord: endCoord,
          label: endLabel,
          itineraryId: itinerary.id,
          signature,
          rowId: endRow?.id,
          distanceKm: endRow?.distanceKm ?? null,
        });
      }

      // 3. Pauses (if enabled in top bar, or if favorite)
      const pauseRows = itinerary.timeline.filter(
        (row) => row.kind === 'pause' && row.visible !== false && (pausesEnabled || row.favorite === true),
      );
      for (const row of pauseRows) {
        let coord: [number, number] | null = null;
        if (row.lat != null && row.lon != null) {
          coord = [row.lon, row.lat];
        } else if (routePoints.length >= 2 && Number.isFinite(row.distanceKm)) {
          const targetM = (row.distanceKm as number) * 1000;
          const pt = interpolateRoutePointAtDistanceM(routePoints, distancesM, targetM);
          if (pt) coord = [pt.lon, pt.lat];
        }

        if (coord) {
          const key = `${itinerary.id}:pause:${row.id}`;
          const label = row.label || translateAppText('Pause');
          const signature = `${key}:${coord[0].toFixed(6)},${coord[1].toFixed(6)}:${label}:${row.distanceKm ?? ''}:${row.durationMin ?? 0}:${row.favorite ? '1' : '0'}`;
          currentCheckpoints.push({
            key,
            kind: 'pause',
            coord,
            label,
            itineraryId: itinerary.id,
            signature,
            pauseId: row.id,
            durationMin: row.durationMin ?? 15,
            distanceKm: row.distanceKm ?? null,
            favorite: row.favorite === true,
          });
        }
      }

      // 3b. Auto-generated interval pauses
      if (
        pausesEnabled &&
        itinerary.rhythm?.pauseEveryIntervalEnabled &&
        itinerary.prediction &&
        itinerary.prediction.points.length >= 2
      ) {
        const reference = parseStartReference(itinerary.rhythm);
        const { autoPauses } = buildScheduledTimelineState(
          itinerary.timeline,
          itinerary.prediction,
          reference,
          itinerary.rhythm,
        );
        for (const autoPause of autoPauses) {
          if (autoPause.visible === false) continue;
          let coord: [number, number] | null = null;
          if (routePoints.length >= 2 && Number.isFinite(autoPause.distanceKm)) {
            const targetM = autoPause.distanceKm * 1000;
            const pt = interpolateRoutePointAtDistanceM(routePoints, distancesM, targetM);
            if (pt) coord = [pt.lon, pt.lat];
          }
          if (coord) {
            const key = `${itinerary.id}:pause:${autoPause.id}`;
            const label = autoPause.label || translateAppText('Pause');
            const signature = `${key}:${coord[0].toFixed(6)},${coord[1].toFixed(6)}:${label}:${autoPause.distanceKm}:${autoPause.durationMin ?? 0}`;
            currentCheckpoints.push({
              key,
              kind: 'pause',
              coord,
              label,
              itineraryId: itinerary.id,
              signature,
              pauseId: autoPause.id,
              durationMin: autoPause.durationMin ?? 15,
              distanceKm: autoPause.distanceKm,
            });
          }
        }
      }

      // 4. Waypoints (if enabled in top bar, or if favorite)
      const waypointRows = itinerary.timeline.filter(
        (row) => row.kind === 'waypoint' && row.visible !== false && (waypointsEnabled || row.favorite === true),
      );
      for (const row of waypointRows) {
        let coord: [number, number] | null = null;
        if (row.lat != null && row.lon != null) {
          coord = [row.lon, row.lat];
        } else if (routePoints.length >= 2 && Number.isFinite(row.distanceKm)) {
          const targetM = (row.distanceKm as number) * 1000;
          const pt = interpolateRoutePointAtDistanceM(routePoints, distancesM, targetM);
          if (pt) coord = [pt.lon, pt.lat];
        }

        if (coord) {
          const key = `${itinerary.id}:waypoint:${row.id}`;
          const label = row.label || translateAppText('Waypoint');
          const signature = `${key}:${coord[0].toFixed(6)},${coord[1].toFixed(6)}:${label}:${row.distanceKm ?? ''}:${row.favorite ? '1' : '0'}`;
          currentCheckpoints.push({
            key,
            kind: 'waypoint',
            coord,
            label,
            itineraryId: itinerary.id,
            signature,
            waypointId: row.id,
            rowId: row.id,
            distanceKm: row.distanceKm ?? null,
            favorite: row.favorite === true,
          });
        }
      }
    }

    const currentKeys = new Set(currentCheckpoints.map((cp) => cp.key));

    // Remove deleted / inactive markers
    for (const [key, entry] of registry.entries()) {
      if (!currentKeys.has(key)) {
        entry.marker.remove();
        registry.delete(key);
      }
    }

    // Compute spread offsets for superposed / co-located checkpoints
    const spreadOffsets = computeCheckpointSpreadOffsets(currentCheckpoints);

    // Add or update markers
    for (const cp of currentCheckpoints) {
      const spreadOffsetPx = spreadOffsets.get(cp.key) ?? 0;
      const existing = registry.get(cp.key);
      if (existing) {
        existing.spreadOffsetPx = spreadOffsetPx;
        if (existing.signature !== cp.signature) {
          existing.marker.setLngLat(cp.coord);
          let kindName = '';
          if (cp.kind === 'start') kindName = translateAppText('Départ');
          else if (cp.kind === 'end') kindName = translateAppText('Arrivée');
          else if (cp.kind === 'pause') kindName = translateAppText('Pause');
          else kindName = translateAppText('Waypoint');
          const distSuffix = cp.distanceKm != null && cp.distanceKm > 0 ? ` (${cp.distanceKm.toFixed(1)} km)` : '';
          const favSuffix = cp.favorite ? ` ★` : '';
          const title =
            cp.label && cp.label !== 'Pause' && cp.label !== 'Waypoint'
              ? `${cp.label}${distSuffix}${favSuffix}`
              : `${kindName}${distSuffix}${favSuffix}`;
          existing.element.title = title;
          existing.element.setAttribute('aria-label', title);
          existing.signature = cp.signature;
          applyTracePointDataset(existing.element, cp);

          if (cp.kind === 'pause' || cp.kind === 'waypoint') {
            existing.element.classList.toggle('is-favorite', Boolean(cp.favorite));
            existing.element.classList.toggle('rv-poi-marker--favorite', Boolean(cp.favorite));
            existing.element.style.zIndex = cp.favorite ? '50' : '20';

            const inner = existing.element.querySelector('.rv-poi-marker__inner');
            if (inner) {
              const existingBadge = inner.querySelector('.rv-poi-marker__favorite-badge');
              if (cp.favorite && !existingBadge) {
                const badge = document.createElement('span');
                badge.className = 'rv-poi-marker__favorite-badge';
                badge.setAttribute('aria-hidden', 'true');
                const badgeIcon = document.createElement('img');
                badgeIcon.className = 'rv-poi-marker__favorite-badge-icon';
                badgeIcon.src = UI_ICON_URLS.star;
                badgeIcon.alt = '';
                badgeIcon.draggable = false;
                badge.appendChild(badgeIcon);
                inner.appendChild(badge);
              } else if (!cp.favorite && existingBadge) {
                existingBadge.remove();
              }
            }
          }
        }
        applyMarkerVisualState(existing, currentZoom);
      } else {
        const element = createMarkerElement(cp.kind, cp.label, cp.durationMin, cp.distanceKm, cp.favorite);
        applyTracePointDataset(element, cp);
        const popup =
          cp.kind === 'pause' && cp.pauseId
            ? createPausePopup(
                cp.pauseId,
                cp.label,
                cp.durationMin ?? 15,
                cp.favorite ?? false,
                {
                  onChangeDuration: (id, dur) => callbacksRef.current.onChangePauseDuration?.(id, dur),
                  onDelete: (id) => callbacksRef.current.onDeletePause?.(id),
                  onToggleFavorite: (id, fav) => callbacksRef.current.onTogglePauseFavorite?.(id, fav),
                },
              )
            : cp.kind === 'waypoint' && cp.waypointId
              ? createWaypointPopup(
                  cp.waypointId,
                  cp.label,
                  cp.favorite ?? false,
                  {
                    onDelete: (id) => callbacksRef.current.onDeleteWaypoint?.(id),
                    onToggleFavorite: (id, fav) => callbacksRef.current.onToggleWaypointFavorite?.(id, fav),
                  },
                )
              : undefined;

        const marker = new mapboxgl.Marker({
          element,
          anchor: 'bottom',
          pitchAlignment: 'viewport',
          rotationAlignment: 'viewport',
          occludedOpacity: 0,
        })
          .setLngLat(cp.coord);

        if (popup) {
          marker.setPopup(popup);
        }

        marker.addTo(map);

        const entry: MarkerRegistryEntry = {
          marker,
          popup,
          signature: cp.signature,
          element,
          kind: cp.kind,
          spreadOffsetPx,
        };

        registry.set(cp.key, entry);
        applyMarkerVisualState(entry, currentZoom);
      }
    }
  }, [itineraries, isMapLoaded, map, pausesEnabled, routesEnabled, waypointsEnabled]);

  // Handle map zoom changes in real-time
  useEffect(() => {
    if (!map) return;

    const handleZoom = () => {
      const currentZoom = map.getZoom();
      registryRef.current.forEach((entry) => {
        applyMarkerVisualState(entry, currentZoom);
      });
    };

    map.on('zoom', handleZoom);
    return () => {
      map.off('zoom', handleZoom);
    };
  }, [map]);

  // Re-anchor on terrain idle (identical to classic POIs)
  useEffect(() => {
    if (!map) return;

    const handleIdle = () => {
      registryRef.current.forEach((entry) => {
        entry.marker.setLngLat(entry.marker.getLngLat());
      });
    };

    map.on('idle', handleIdle);
    return () => {
      map.off('idle', handleIdle);
    };
  }, [map]);

  // Clean up on unmount
  useEffect(() => {
    const registry = registryRef.current;
    return () => {
      registry.forEach((entry) => entry.marker.remove());
      registry.clear();
    };
  }, []);
}
