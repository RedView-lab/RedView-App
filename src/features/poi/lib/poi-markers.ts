// 3D POI markers — DOM `mapboxgl.Marker` pipeline.
//
// POIs are rendered as DOM markers rather than symbol layers, on purpose:
//
// - DOM markers are never culled by Mapbox's symbol placement engine or by
//   terrain depth-occlusion (the repeated failure mode of the previous
//   symbol-layer implementation at the app's default 60° pitch).
// - They survive `setStyle()` reloads — no sprite re-registration, no
//   source/layer re-creation on `styledata`.
// - Icons are plain `<img src>` SVGs: no canvas rasterisation, no sprite
//   atlas races, no `addImage` lifecycle.
//
// Terrain note: markers carry NO `altitude` option, exactly like the
// viewport POI markers in DashboardPlaceSearch (the reference
// implementation, verified pixel-perfect on 3D terrain). Mapbox samples the
// rendered (exaggerated) DEM itself on every projection and keeps the
// marker glued to the surface through rotation/pitch/zoom. Never set an
// altitude on top — any extra meters displace the pin vertically and make
// it drift with parallax when the camera rotates. An `idle` nudge
// re-projects markers created before DEM tiles loaded.

import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import { flyToLocation } from '@/features/map3d';

import type { PoiFeature } from '../types';
import { POI_LABELS } from '../types';
import { getPoiIconUrl, hasDedicatedFavoritePoiIcon } from './poi-icons';
import {
  buildPopupContent,
  resolvePopupState,
  type PoiPopupState,
  type UsePoiPopupActions,
} from './poi-popup';

// ── Visual tuning ─────────────────────────────────────────────────────

const MARKER_MIN_SCALE_ZOOM = 8.25;
const MARKER_MAX_SCALE_ZOOM = 15.1;
const MARKER_MIN_SCREEN_SCALE = 0.42;
const MARKER_MAX_SCREEN_SCALE = 1;
const MARKER_MIN_POPUP_OFFSET_PX = 38;
const MARKER_MAX_POPUP_OFFSET_PX = 80;
/** Occlusion relief 3D : 0 pour masquer complètement les POI situés derrière les montagnes. */
const MARKER_OCCLUDED_OPACITY = 0;

const FAVORITE_BADGE_ICON_URL = '/svgv2/icone/star-01.svg';
const SUPERPOSED_PROXIMITY_M = 18;
const SUPERPOSED_SPREAD_STEP_PX = 26;

interface PoiMarkerEntry {
  marker: mapboxgl.Marker;
  popup: mapboxgl.Popup;
  signature: string;
  feature: PoiFeature;
  spreadOffsetPx: number;
}

export function getMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

function getMarkerSignature(feature: PoiFeature): string {
  return [
    feature.lat,
    feature.lon,
    feature.category,
    feature.favorite ? 'favorite' : 'default',
    feature.name ?? '',
    feature.tags.opening_hours ?? '',
  ].join('|');
}

function computeSuperposedSpreadOffsets(features: PoiFeature[]): Map<string, number> {
  const offsetMap = new Map<string, number>();
  if (features.length === 0) return offsetMap;

  const clusters: PoiFeature[][] = [];
  for (const feature of features) {
    let targetCluster: PoiFeature[] | null = null;
    for (const cluster of clusters) {
      const anchor = cluster[0];
      const dLat = (feature.lat - anchor.lat) * 111320;
      const dLon =
        (feature.lon - anchor.lon) *
        111320 *
        Math.cos(((feature.lat + anchor.lat) / 2) * (Math.PI / 180));
      const distM = Math.hypot(dLat, dLon);
      if (distM <= SUPERPOSED_PROXIMITY_M) {
        targetCluster = cluster;
        break;
      }
    }
    if (targetCluster) {
      targetCluster.push(feature);
    } else {
      clusters.push([feature]);
    }
  }

  for (const cluster of clusters) {
    const N = cluster.length;
    if (N <= 1) {
      offsetMap.set(getMarkerKey(cluster[0]), 0);
      continue;
    }

    // Sort so non-favorites are first, favorites last (rendered on top / in front)
    cluster.sort((a, b) => {
      if (Boolean(a.favorite) !== Boolean(b.favorite)) {
        return a.favorite ? 1 : -1;
      }
      return 0;
    });

    cluster.forEach((feature, idx) => {
      const centerOffset = idx - (N - 1) / 2;
      offsetMap.set(getMarkerKey(feature), Math.round(centerOffset * SUPERPOSED_SPREAD_STEP_PX));
    });
  }

  return offsetMap;
}

// ── Marker DOM ────────────────────────────────────────────────────────

function createMarkerElement(feature: PoiFeature): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `rv-poi-marker${feature.favorite ? ' is-favorite rv-poi-marker--favorite' : ''}`;
  element.dataset.poiCategory = feature.category;
  element.style.zIndex = feature.favorite ? '50' : '20';
  element.setAttribute(
    'aria-label',
    feature.name?.trim()
      ? `${feature.name} - ${POI_LABELS[feature.category]}`
      : POI_LABELS[feature.category],
  );
  element.title = feature.name?.trim() || POI_LABELS[feature.category];

  const inner = document.createElement('div');
  inner.className = 'rv-poi-marker__inner';

  const image = document.createElement('img');
  image.className = 'rv-poi-marker__img';
  image.src = getPoiIconUrl(feature.category, feature.favorite === true);
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  inner.appendChild(image);

  // Categories without a dedicated favorite sprite get a star badge overlay.
  if (feature.favorite && !hasDedicatedFavoritePoiIcon(feature.category)) {
    const badge = document.createElement('span');
    badge.className = 'rv-poi-marker__favorite-badge';
    badge.setAttribute('aria-hidden', 'true');

    const badgeIcon = document.createElement('img');
    badgeIcon.className = 'rv-poi-marker__favorite-badge-icon';
    badgeIcon.src = FAVORITE_BADGE_ICON_URL;
    badgeIcon.alt = '';
    badgeIcon.draggable = false;
    badge.appendChild(badgeIcon);

    inner.appendChild(badge);
  }

  element.appendChild(inner);

  element.addEventListener('mouseenter', () => {
    element.style.zIndex = '100';
  });
  element.addEventListener('mouseleave', () => {
    element.style.zIndex = feature.favorite ? '50' : '20';
  });

  return element;
}

// ── Zoom-responsive sizing ────────────────────────────────────────────

interface PoiMarkerVisualState {
  scale: number;
  popupOffsetPx: number;
}

function getMarkerVisualState(zoom: number): PoiMarkerVisualState {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  return {
    scale: lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress),
    popupOffsetPx: Math.round(
      lerp(MARKER_MIN_POPUP_OFFSET_PX, MARKER_MAX_POPUP_OFFSET_PX, progress),
    ),
  };
}

function applyMarkerVisualState(entry: PoiMarkerEntry, zoom: number): void {
  const el = entry.marker.getElement();
  const visual = getMarkerVisualState(zoom);
  el.style.setProperty(
    '--rv-poi-marker-scale',
    visual.scale.toFixed(3),
  );
  const scaledSpreadPx = Math.round(entry.spreadOffsetPx * visual.scale);
  el.style.setProperty(
    '--rv-poi-spread-x',
    `${scaledSpreadPx}px`,
  );
  entry.popup.setOffset([scaledSpreadPx, visual.popupOffsetPx]);
}

// ── Manager ───────────────────────────────────────────────────────────

/**
 * Owns the full lifecycle of the POI DOM markers for one map instance:
 * diffed reconciliation, zoom/terrain visual refresh and teardown.
 */
export class PoiMarkerManager {
  private readonly map: MapboxMap;
  private readonly getActions: () => UsePoiPopupActions;
  private readonly registry = new Map<string, PoiMarkerEntry>();
  private frameId: number | null = null;

  private readonly scheduleVisualRefresh = (): void => {
    if (this.frameId != null) return;
    this.frameId = window.requestAnimationFrame(() => {
      this.frameId = null;
      const zoom = this.map.getZoom();
      for (const entry of this.registry.values()) {
        applyMarkerVisualState(entry, zoom);
      }
    });
  };

  // Markers created before DEM tiles finished loading were projected with a
  // default elevation; re-setting their LngLat forces a re-projection that
  // re-samples the now-loaded terrain. `idle` fires exactly when tiles and
  // camera settle, and the nudge itself does not schedule another repaint.
  private readonly reanchorOnIdle = (): void => {
    for (const entry of this.registry.values()) {
      entry.marker.setLngLat(entry.marker.getLngLat());
    }
  };

  constructor(map: MapboxMap, getActions: () => UsePoiPopupActions) {
    this.map = map;
    this.getActions = getActions;
    map.on('zoom', this.scheduleVisualRefresh);
    map.on('idle', this.reanchorOnIdle);
  }

  /** Currently rendered feature count. */
  get size(): number {
    return this.registry.size;
  }

  private spreadOffsets = new Map<string, number>();

  /**
   * Reconcile rendered markers against `features`: removes stale markers,
   * keeps unchanged ones (same signature) and (re)creates the rest.
   * Also computes horizontal spread offsets so co-located / superposed POIs all appear.
   */
  sync(features: PoiFeature[]): void {
    this.spreadOffsets = computeSuperposedSpreadOffsets(features);
    const nextKeys = new Set(features.map(getMarkerKey));

    for (const [key, entry] of this.registry) {
      if (nextKeys.has(key)) continue;
      entry.marker.remove();
      this.registry.delete(key);
    }

    for (const feature of features) {
      const key = getMarkerKey(feature);
      const signature = getMarkerSignature(feature);
      const spreadOffsetPx = this.spreadOffsets.get(key) ?? 0;
      const existing = this.registry.get(key);

      if (existing && existing.signature === signature) {
        if (existing.spreadOffsetPx !== spreadOffsetPx) {
          existing.spreadOffsetPx = spreadOffsetPx;
          applyMarkerVisualState(existing, this.map.getZoom());
        }
        continue;
      }

      existing?.marker.remove();
      this.registry.set(key, this.createEntry(feature, spreadOffsetPx));
    }
  }

  /** Remove every marker and detach map listeners. */
  destroy(): void {
    if (this.frameId != null) {
      window.cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.map.off('zoom', this.scheduleVisualRefresh);
    this.map.off('idle', this.reanchorOnIdle);
    for (const entry of this.registry.values()) {
      entry.marker.remove();
    }
    this.registry.clear();
  }

  /**
   * Opens the popup for a POI and centers the map on it.
   */
  openPoi(poiId: number | string, category?: string, coords?: { lat: number; lon: number }): boolean {
    const idStr = String(poiId);
    const cleanId = idStr.replace(/^poi-/, '');
    let targetEntry: PoiMarkerEntry | null = null;

    for (const [key, entry] of this.registry.entries()) {
      if (
        key === idStr ||
        key.endsWith(`:${idStr}`) ||
        key.endsWith(`:${cleanId}`) ||
        String(entry.feature.id) === idStr ||
        String(entry.feature.id) === cleanId ||
        (category && (key === `${category}:${idStr}` || key === `${category}:${cleanId}`))
      ) {
        targetEntry = entry;
        break;
      }
    }

    if (!targetEntry && coords) {
      for (const entry of this.registry.values()) {
        const dLat = Math.abs(entry.feature.lat - coords.lat);
        const dLon = Math.abs(entry.feature.lon - coords.lon);
        if (dLat < 0.0001 && dLon < 0.0001) {
          targetEntry = entry;
          break;
        }
      }
    }

    if (!targetEntry) return false;

    // Close any other open popups
    for (const other of this.registry.values()) {
      if (other !== targetEntry && other.popup.isOpen()) {
        other.popup.remove();
      }
    }

    if (!targetEntry.popup.isOpen()) {
      targetEntry.marker.togglePopup();
    }

    const lngLat = targetEntry.marker.getLngLat();
    flyToLocation(this.map, { lon: lngLat.lng, lat: lngLat.lat }, { zoom: 15.5 });

    return true;
  }

  private createEntry(feature: PoiFeature, spreadOffsetPx: number): PoiMarkerEntry {
    const popup = new mapboxgl.Popup({
      className: 'rv-poi-popup',
      closeButton: false,
      closeOnClick: true,
      focusAfterOpen: false,
      maxWidth: 'none',
      offset: MARKER_MAX_POPUP_OFFSET_PX,
    });

    // Popup DOM is built lazily, on first open, then kept in sync while
    // open. Building it eagerly for every marker (the previous behaviour)
    // cost one full popup DOM tree per POI at creation time — fine for a
    // shortlist of a few dozen POIs, untenable now that the exhaustive
    // corridor search can legitimately return thousands of them.
    const refresh = (nextState?: PoiPopupState) => {
      const actions = this.getActions();
      popup.setDOMContent(buildPopupContent(
        feature,
        resolvePopupState(actions, feature, nextState),
        actions,
        refresh,
      ));
    };

    // Re-resolve state from the itinerary every time the popup reopens.
    popup.on('open', () => {
      refresh();
      this.getActions().onSelectPoi?.(feature);
    });

    const markerEl = createMarkerElement(feature);
    markerEl.addEventListener('click', () => {
      this.getActions().onSelectPoi?.(feature);
    });

    const marker = new mapboxgl.Marker({
      element: markerEl,
      anchor: 'bottom',
      pitchAlignment: 'viewport',
      rotationAlignment: 'viewport',
      // No `altitude`: identical projection path to the viewport POI
      // markers — Mapbox anchors the pin tip on the terrain surface.
      occludedOpacity: MARKER_OCCLUDED_OPACITY,
    })
      .setLngLat([feature.lon, feature.lat])
      .setPopup(popup)
      .addTo(this.map);

    const entry: PoiMarkerEntry = {
      marker,
      popup,
      signature: getMarkerSignature(feature),
      feature,
      spreadOffsetPx,
    };

    applyMarkerVisualState(entry, this.map.getZoom());
    return entry;
  }
}

// ── Math helpers ──────────────────────────────────────────────────────

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
