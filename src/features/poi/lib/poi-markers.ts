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
// Terrain note: `Marker.altitude` is RELATIVE to the rendered terrain
// surface. Mapbox samples the (exaggerated) DEM itself on every projection
// (`_coordinatePoint`: z = sampled terrain elevation + marker altitude), so
// markers stay glued to the ground through rotation/pitch with a small
// constant lift. Never add `queryTerrainElevation` on top — that double-
// counts the terrain height and makes POIs float and drift with parallax.
// An `idle` nudge re-projects markers created before DEM tiles loaded.

import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';

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
/** Meters above the terrain surface (relative offset, sampled by Mapbox). */
const MARKER_LIFT_M = 1.5;
const MARKER_MIN_POPUP_OFFSET_PX = 26;
const MARKER_MAX_POPUP_OFFSET_PX = 34;

const FAVORITE_BADGE_ICON_URL = '/svgv2/icone/star-01.svg';

interface PoiMarkerEntry {
  marker: mapboxgl.Marker;
  popup: mapboxgl.Popup;
  signature: string;
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

// ── Marker DOM ────────────────────────────────────────────────────────

function createMarkerElement(feature: PoiFeature): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'rv-poi-marker';
  element.dataset.poiCategory = feature.category;
  element.setAttribute(
    'aria-label',
    feature.name?.trim()
      ? `${feature.name} - ${POI_LABELS[feature.category]}`
      : POI_LABELS[feature.category],
  );
  element.title = feature.name?.trim() || POI_LABELS[feature.category];

  const image = document.createElement('img');
  image.className = 'rv-poi-marker__img';
  image.src = getPoiIconUrl(feature.category, feature.favorite === true);
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  element.appendChild(image);

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

    element.appendChild(badge);
  }

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
  const visual = getMarkerVisualState(zoom);
  entry.marker.getElement().style.setProperty(
    '--rv-poi-marker-scale',
    visual.scale.toFixed(3),
  );
  entry.popup.setOffset(visual.popupOffsetPx);
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

  /**
   * Reconcile rendered markers against `features`: removes stale markers,
   * keeps unchanged ones (same signature) and (re)creates the rest.
   */
  sync(features: PoiFeature[]): void {
    const nextKeys = new Set(features.map(getMarkerKey));

    for (const [key, entry] of this.registry) {
      if (nextKeys.has(key)) continue;
      entry.marker.remove();
      this.registry.delete(key);
    }

    for (const feature of features) {
      const key = getMarkerKey(feature);
      const signature = getMarkerSignature(feature);
      const existing = this.registry.get(key);
      if (existing && existing.signature === signature) continue;

      existing?.marker.remove();
      this.registry.set(key, this.createEntry(feature));
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

  private createEntry(feature: PoiFeature): PoiMarkerEntry {
    const popup = new mapboxgl.Popup({
      className: 'rv-poi-popup',
      closeButton: false,
      closeOnClick: true,
      focusAfterOpen: false,
      maxWidth: 'none',
      offset: MARKER_MAX_POPUP_OFFSET_PX,
    });

    const refresh = (nextState?: PoiPopupState) => {
      const actions = this.getActions();
      popup.setDOMContent(buildPopupContent(
        feature,
        resolvePopupState(actions, feature, nextState),
        actions,
        refresh,
      ));
    };

    refresh();
    // Re-resolve state from the itinerary every time the popup reopens.
    popup.on('open', () => refresh());

    const marker = new mapboxgl.Marker({
      element: createMarkerElement(feature),
      anchor: 'bottom',
      pitchAlignment: 'viewport',
      rotationAlignment: 'viewport',
      // Relative to the terrain surface: keeps the pin tip just above the
      // ground without z-fighting the DEM mesh.
      altitude: MARKER_LIFT_M,
      // Never fade markers hidden by terrain: at high pitch the anchor often
      // sits just behind the DEM surface and the default 0.2 made POIs
      // near-invisible.
      occludedOpacity: 1,
    })
      .setLngLat([feature.lon, feature.lat])
      .setPopup(popup) // copies the marker altitude onto the popup
      .addTo(this.map);

    const entry: PoiMarkerEntry = {
      marker,
      popup,
      signature: getMarkerSignature(feature),
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
