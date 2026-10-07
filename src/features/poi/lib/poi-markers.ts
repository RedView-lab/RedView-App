// 3D POI markers — GPU `symbol` layer pipeline.
//
// POIs used to be one DOM `mapboxgl.Marker` each. With exhaustive corridor
// searches (800+ POIs on a GR20-like route) that meant thousands of DOM nodes,
// ~3 200 map listeners, one terrain projection + one occlusion raycast per
// marker on every camera frame, and 800 CSS drop-shadows repainted per frame.
//
// They are now drawn by ONE Mapbox symbol layer fed by ONE GeoJSON source:
//
// - Sprites are composed once per visual variant (category × favorite ×
//   pause) by `poi-sprites.ts` — same SVGs, same badges, shadows baked in —
//   and registered with `addImage` at a HiDPI pixel ratio.
// - The historical failure modes of the old symbol-layer implementation are
//   neutralised explicitly: `icon-allow-overlap` + `icon-ignore-placement`
//   (placement never drops a POI), `icon-occlusion-opacity` (terrain
//   occlusion handled by the GPU depth test, same result as the former
//   `occludedOpacity: 0`), viewport pitch/rotation alignment.
// - Style reloads are handled by re-installing source/images/layers on
//   `styledata` (cheap `getLayer` guard).
// - Hover uses `feature-state` + a one-feature highlight layer; a single
//   shared `Popup` replaces the 800 per-marker instances.
// - Hit testing is pixel-exact (`poi-hit-mask.ts`), never Mapbox's own: it
//   tests a symbol on its whole image, padding included, and returns
//   overlapping symbols in data order rather than drawing order.
//
// Per-frame cost is therefore independent of the number of POIs.

import mapboxgl from 'mapbox-gl';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapboxMap,
  MapMouseEvent,
} from 'mapbox-gl';
import { flyToPoi } from '@/features/map3d/lib/cameraFlight';
import { MAP_CURSOR_PRIORITY, setMapCursor } from '@/features/map3d/lib/mapCursor';
import { keepPopupInVisibleMap } from '@/features/map3d/lib/mapPopupSafeArea';
import { isEventFromDomMarker } from '@/features/map3d/lib/pointPanelDismiss';
import { buildPopupClearanceOffset } from '@/features/map3d/lib/popupOffset';

import type { PoiFeature } from '../types';
import { POI_LABELS } from '../types';
import {
  buildPopupContent,
  resolvePopupState,
  type PoiPopupState,
  type UsePoiPopupActions,
} from './poi-popup';
import { pickPoiHit, type PoiHitCandidate } from './poi-hit-mask';
import {
  getPoiSpriteId,
  getPoiSpritePixelRatio,
  getPoiSpriteSpec,
  rasterizePoiSprite,
  type PoiSprite,
  type PoiSpriteSpec,
} from './poi-sprites';

// ── Visual tuning ─────────────────────────────────────────────────────

const MARKER_MIN_SCALE_ZOOM = 8.25;
const MARKER_MAX_SCALE_ZOOM = 15.1;
const MARKER_MIN_SCREEN_SCALE = 0.42;
const MARKER_MAX_SCREEN_SCALE = 1;
// Terrain occlusion: `icon-occlusion-opacity` is deliberately NOT set. Absent,
// Mapbox fully hides icons behind the relief only (same result as the former
// DOM `occludedOpacity: 0`). Setting it switches to a generic depth test, and
// the route line — elevated in 3D via `line-z-offset` — then hid the icons.
/** Hover lift, identical to the former `.rv-poi-marker:hover` CSS. */
const HOVER_SCALE = 1.03;
const HOVER_LIFT_PX = 4;
/** A click this close (screen px) to a drawn POI still opens it. */
const HIT_TOLERANCE_PX = 3;
/** Visible half size of a round POI (icon-size 1), until its sprite is measured. */
const FALLBACK_HALF_EXTENT_PX = 11;
const POI_CURSOR_OWNER = 'poi-hover';
export const POI_GPU_SOURCE_ID = 'rv-poi-gpu-source';
export const POI_GPU_LAYER_ID = 'rv-poi-gpu-symbols';
export const POI_GPU_HOVER_LAYER_ID = 'rv-poi-gpu-hover';

export function getMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

// ── Zoom-responsive sizing ────────────────────────────────────────────

/** Former CSS: box = base * (0.8 + 0.35 * scale), scale = smoothstep(zoom). */
function getIconSizeAtZoom(zoom: number): number {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  const scale = lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress);
  return 0.8 + 0.35 * scale;
}

/** Piecewise-linear sampling of the smoothstep curve as a zoom expression. */
function buildIconSizeExpression(multiplier = 1): ExpressionSpecification {
  const stops: number[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i += 1) {
    const zoom = MARKER_MIN_SCALE_ZOOM + ((MARKER_MAX_SCALE_ZOOM - MARKER_MIN_SCALE_ZOOM) * i) / steps;
    stops.push(Number(zoom.toFixed(3)), Number((getIconSizeAtZoom(zoom) * multiplier).toFixed(4)));
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops] as ExpressionSpecification;
}

// ── GeoJSON ───────────────────────────────────────────────────────────

interface PoiGeoJsonProperties {
  key: string;
  icon: string;
  sort: number;
  name: string;
}

type PoiFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, PoiGeoJsonProperties>;

const EMPTY_COLLECTION: PoiFeatureCollection = { type: 'FeatureCollection', features: [] };

function poiDisplayName(feature: PoiFeature): string {
  return feature.name?.trim() || POI_LABELS[feature.category];
}

// ── Hit-testing registry (used by map tools that used to look for DOM markers) ──

const managersByMap = new WeakMap<MapboxMap, PoiMarkerManager>();

/**
 * Hides every POI while another feature needs a clean map (flyover: the
 * route alone). Survives style reloads; popup and hover are dropped.
 */
export function setPoiLayersSuppressed(map: MapboxMap, suppressed: boolean): void {
  managersByMap.get(map)?.setSuppressed(suppressed);
}

/** POI rendered under (or within `radiusPx` of) a canvas point, nearest first. */
export function queryPoiAtPoint(
  map: MapboxMap,
  point: { x: number; y: number },
  radiusPx = 0,
): PoiFeature | null {
  return managersByMap.get(map)?.queryAt(point, radiusPx) ?? null;
}

// ── Manager ───────────────────────────────────────────────────────────

/**
 * Owns the POI GPU layer for one map instance: sprite registration,
 * diffed `setData`, hover/click, the shared popup and teardown.
 * Public API kept identical to the former DOM marker manager.
 */
export class PoiMarkerManager {
  private readonly map: MapboxMap;
  private readonly getActions: () => UsePoiPopupActions;
  private readonly features = new Map<string, PoiFeature>();
  private readonly sprites = new Map<string, PoiSprite>();
  private readonly pendingSprites = new Map<string, Promise<void>>();
  private readonly pixelRatio = getPoiSpritePixelRatio();
  private data: PoiFeatureCollection = EMPTY_COLLECTION;
  /** Index of each rendered POI in `data`, which is also its drawing order. */
  private readonly drawRankByKey = new Map<string, number>();
  /** Largest drawn distance from an anchor among the sprites (icon-size 1). */
  private maxHitExtentPx = FALLBACK_HALF_EXTENT_PX;
  /** Signature of `data` (what should be on screen). */
  private renderedSignature = '';
  /** Signature of what was last uploaded to the source. */
  private dataSignature = '';
  private syncToken = 0;
  private destroyed = false;
  private hoveredKey: string | null = null;
  private popup: mapboxgl.Popup | null = null;
  private popupKey: string | null = null;
  /**
   * POI dont le panneau était ouvert au moment de l'appui. Mapbox ferme le
   * popup au `preclick` (closeOnClick), avant le `click` du calque : sans ce
   * repère, recliquer le POI ouvert le rouvrait aussitôt au lieu de le fermer.
   */
  private pressedOpenPopupKey: string | null = null;
  private suppressed = false;
  private zoomFrameId: number | null = null;
  private raiseFrameId: number | null = null;
  private hoverFrameId: number | null = null;
  /** Last pointer position on the canvas, resolved on the next frame. */
  private hoverPoint: { x: number; y: number } | null = null;

  constructor(map: MapboxMap, getActions: () => UsePoiPopupActions) {
    this.map = map;
    this.getActions = getActions;
    managersByMap.set(map, this);
    map.on('styledata', this.handleStyleData);
    map.on('zoom', this.handleZoom);
    map.on('mousedown', this.handleMapMouseDown);
    map.on('click', this.handleMapClick);
    map.on('mousemove', this.handleMapMouseMove);
    map.on('mouseout', this.handleMapMouseOut);
    this.ensureLayers();
  }

  /** Currently rendered feature count. */
  get size(): number {
    return this.features.size;
  }

  /**
   * Reconcile rendered POIs against `features`. Missing sprite variants are
   * rasterised first (async, once per variant); the GeoJSON source is only
   * re-uploaded when the rendered set actually changed.
   */
  sync(features: PoiFeature[]): void {
    this.features.clear();
    for (const feature of features) {
      this.features.set(getMarkerKey(feature), feature);
    }

    const token = ++this.syncToken;
    const waits: Promise<void>[] = [];
    for (const feature of this.features.values()) {
      const spec = getPoiSpriteSpec(feature);
      const id = getPoiSpriteId(spec);
      if (this.sprites.has(id)) continue;
      waits.push(this.loadSprite(id, spec));
    }

    if (waits.length === 0) {
      this.flush();
      return;
    }
    void Promise.all(waits).then(() => {
      if (this.destroyed || token !== this.syncToken) return;
      this.flush();
    });
  }

  /** Remove the layer, the popup and every listener. */
  destroy(): void {
    this.destroyed = true;
    if (this.zoomFrameId != null) {
      window.cancelAnimationFrame(this.zoomFrameId);
      this.zoomFrameId = null;
    }
    if (this.raiseFrameId != null) {
      window.cancelAnimationFrame(this.raiseFrameId);
      this.raiseFrameId = null;
    }
    if (this.hoverFrameId != null) {
      window.cancelAnimationFrame(this.hoverFrameId);
      this.hoverFrameId = null;
    }
    this.map.off('styledata', this.handleStyleData);
    this.map.off('zoom', this.handleZoom);
    this.map.off('mousedown', this.handleMapMouseDown);
    this.map.off('click', this.handleMapClick);
    this.map.off('mousemove', this.handleMapMouseMove);
    this.map.off('mouseout', this.handleMapMouseOut);
    setMapCursor(this.map, POI_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.hover);
    this.popup?.remove();
    this.popup = null;
    this.popupKey = null;
    if (managersByMap.get(this.map) === this) managersByMap.delete(this.map);
    try {
      if (this.map.getLayer(POI_GPU_HOVER_LAYER_ID)) this.map.removeLayer(POI_GPU_HOVER_LAYER_ID);
      if (this.map.getLayer(POI_GPU_LAYER_ID)) this.map.removeLayer(POI_GPU_LAYER_ID);
      if (this.map.getSource(POI_GPU_SOURCE_ID)) this.map.removeSource(POI_GPU_SOURCE_ID);
      for (const id of this.sprites.keys()) {
        if (this.map.hasImage(id)) this.map.removeImage(id);
      }
    } catch {
      // Map already torn down.
    }
    this.features.clear();
  }

  /**
   * Opens the popup for a POI and centers the map on it.
   */
  openPoi(poiId: number | string, category?: string, coords?: { lat: number; lon: number }): boolean {
    const idStr = String(poiId);
    const strippedPrefix = idStr.replace(/^.*::/, '');
    const cleanId = strippedPrefix.replace(/^(poi-|feature-|poi-timeline-)/, '');
    let targetKey: string | null = null;

    for (const [key, feature] of this.features) {
      const featureId = String(feature.id);
      if (
        key === idStr ||
        key === strippedPrefix ||
        key.endsWith(`:${idStr}`) ||
        key.endsWith(`:${strippedPrefix}`) ||
        key.endsWith(`:${cleanId}`) ||
        featureId === idStr ||
        featureId === strippedPrefix ||
        featureId === cleanId ||
        (category && (
          key === `${category}:${idStr}` ||
          key === `${category}:${strippedPrefix}` ||
          key === `${category}:${cleanId}`
        ))
      ) {
        targetKey = key;
        break;
      }
    }

    if (!targetKey && coords) {
      let minDistanceSq = 0.001 * 0.001; // ~100 m
      for (const [key, feature] of this.features) {
        const dLat = feature.lat - coords.lat;
        const dLon = feature.lon - coords.lon;
        const distSq = dLat * dLat + dLon * dLon;
        if (distSq < minDistanceSq) {
          minDistanceSq = distSq;
          targetKey = key;
        }
      }
    }

    const target = targetKey ? this.features.get(targetKey) : undefined;
    if (!targetKey || !target) return false;

    if (this.popupKey === targetKey && this.popup?.isOpen()) {
      this.getActions().onSelectPoi?.(target);
    } else {
      this.openPopup(targetKey, target);
    }

    flyToPoi(this.map, { lon: target.lon, lat: target.lat });

    return true;
  }

  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    if (suppressed) {
      this.popup?.remove();
      this.setHovered(null);
    }
    this.applyVisibility();
  }

  /** Topmost POI drawn under a canvas point, else the nearest within `radiusPx` (min 3 px). */
  queryAt(point: { x: number; y: number }, radiusPx: number): PoiFeature | null {
    const key = this.queryKeyAt(point, radiusPx);
    return key ? this.features.get(key) ?? null : null;
  }

  /** Open the POI under / around a canvas point. */
  activateAt(point: { x: number; y: number }, radiusPx: number): boolean {
    const key = this.queryKeyAt(point, radiusPx);
    const feature = key ? this.features.get(key) : undefined;
    if (!key || !feature) return false;
    this.openPopup(key, feature);
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Pixel-exact hit test. Mapbox only supplies the candidates — symbols whose
   * image intersects a box wide enough for any drawn pixel to reach the
   * point, terrain occlusion included — then each candidate's mask decides,
   * at its projected anchor and current icon size (`pickPoiHit`).
   */
  private queryKeyAt(point: { x: number; y: number }, radiusPx: number): string | null {
    try {
      if (this.suppressed || !this.map.getLayer(POI_GPU_LAYER_ID)) return null;
      const tolerance = Math.max(HIT_TOLERANCE_PX, radiusPx);
      const size = getIconSizeAtZoom(this.map.getZoom());
      const reach = this.maxHitExtentPx * size * HOVER_SCALE + HOVER_LIFT_PX + tolerance;
      const hits = this.map.queryRenderedFeatures(
        [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]],
        { layers: [POI_GPU_LAYER_ID] },
      );
      if (hits.length === 0) return null;
      const candidates: PoiHitCandidate<string>[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        const key = String(hit.properties?.key ?? '');
        // A feature straddling tiles comes back once per tile.
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const feature = this.features.get(key);
        const sprite = feature ? this.sprites.get(getPoiSpriteId(getPoiSpriteSpec(feature))) : undefined;
        if (!feature || !sprite) continue;
        const anchor = this.map.project([feature.lon, feature.lat]);
        const placements = [{ x: anchor.x, y: anchor.y, scale: size }];
        // The hovered POI is drawn lifted and scaled: both places count, so
        // the lift never moves it out from under the pointer.
        if (key === this.hoveredKey) {
          placements.push({ x: anchor.x, y: anchor.y - HOVER_LIFT_PX, scale: size * HOVER_SCALE });
        }
        candidates.push({ key, mask: sprite.hitMask, drawRank: this.drawRankByKey.get(key) ?? 0, placements });
      }
      return pickPoiHit(candidates, point, tolerance);
    } catch {
      return null;
    }
  }

  private loadSprite(id: string, spec: PoiSpriteSpec): Promise<void> {
    let pending = this.pendingSprites.get(id);
    if (!pending) {
      pending = rasterizePoiSprite(spec, this.pixelRatio)
        .then((sprite) => {
          if (!sprite) return;
          this.sprites.set(id, sprite);
          const bounds = sprite.hitMask.bounds;
          if (bounds) {
            this.maxHitExtentPx = Math.max(
              this.maxHitExtentPx,
              -bounds.minX,
              bounds.maxX,
              -bounds.minY,
              bounds.maxY,
            );
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.pendingSprites.delete(id);
        });
      this.pendingSprites.set(id, pending);
    }
    return pending;
  }

  private ensureLayers(): boolean {
    if (this.destroyed) return false;
    const map = this.map;
    try {
      if (!map.getStyle()) return false;
    } catch {
      return false;
    }

    try {
      for (const sprite of this.sprites.values()) {
        if (!map.hasImage(sprite.id)) {
          map.addImage(sprite.id, sprite.image, { pixelRatio: sprite.pixelRatio });
        }
      }

      if (!map.getSource(POI_GPU_SOURCE_ID)) {
        map.addSource(POI_GPU_SOURCE_ID, {
          type: 'geojson',
          data: this.data,
          promoteId: 'key',
        });
      }

      const sharedLayout = {
        'icon-image': ['get', 'icon'] as ExpressionSpecification,
        'icon-anchor': 'center' as const,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-pitch-alignment': 'viewport' as const,
        'icon-rotation-alignment': 'viewport' as const,
        'symbol-sort-key': ['get', 'sort'] as ExpressionSpecification,
      };

      if (!map.getLayer(POI_GPU_LAYER_ID)) {
        map.addLayer({
          id: POI_GPU_LAYER_ID,
          type: 'symbol',
          source: POI_GPU_SOURCE_ID,
          slot: 'top',
          layout: {
            ...sharedLayout,
            'icon-size': buildIconSizeExpression(),
          },
          paint: {
            'icon-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0,
              1,
            ],
            'icon-opacity-transition': { duration: 0, delay: 0 },
            'icon-emissive-strength': 1,
          },
        });
      }

      if (!map.getLayer(POI_GPU_HOVER_LAYER_ID)) {
        map.addLayer({
          id: POI_GPU_HOVER_LAYER_ID,
          type: 'symbol',
          source: POI_GPU_SOURCE_ID,
          slot: 'top',
          filter: ['==', ['get', 'key'], this.hoveredKey ?? ''],
          layout: {
            ...sharedLayout,
            'icon-size': buildIconSizeExpression(HOVER_SCALE),
          },
          paint: {
            'icon-translate': [0, -HOVER_LIFT_PX],
            'icon-translate-anchor': 'viewport',
            'icon-emissive-strength': 1,
          },
        });
      }
      this.applyVisibility();
      return true;
    } catch {
      return false;
    }
  }

  private applyVisibility(): void {
    const visibility = this.suppressed ? 'none' : 'visible';
    try {
      for (const layerId of [POI_GPU_LAYER_ID, POI_GPU_HOVER_LAYER_ID]) {
        if (this.map.getLayer(layerId) && this.map.getLayoutProperty(layerId, 'visibility') !== visibility) {
          this.map.setLayoutProperty(layerId, 'visibility', visibility);
        }
      }
    } catch {
      // Style swapping: re-applied by ensureLayers on the next styledata.
    }
  }

  private flush(): void {
    if (this.destroyed) return;

    const features: PoiFeatureCollection['features'] = [];
    const signatureParts: string[] = [];
    for (const [key, feature] of this.features) {
      const icon = getPoiSpriteId(getPoiSpriteSpec(feature));
      if (!this.sprites.has(icon)) continue;
      const sort = (feature.favorite ? 2 : 0) + ((feature.pauseDurationMin ?? 0) > 0 ? 1 : 0);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [feature.lon, feature.lat] },
        properties: { key, icon, sort, name: poiDisplayName(feature) },
      });
    }
    // Data in drawing order (stable sort on the sort key): favourites and
    // pauses last, i.e. on top, and the index is the hit-test draw rank.
    features.sort((a, b) => a.properties.sort - b.properties.sort);
    this.drawRankByKey.clear();
    features.forEach((entry, index) => {
      this.drawRankByKey.set(entry.properties.key, index);
      const [lon, lat] = entry.geometry.coordinates;
      signatureParts.push(`${entry.properties.key}|${entry.properties.icon}|${lon}|${lat}`);
    });
    this.data = { type: 'FeatureCollection', features };
    this.renderedSignature = signatureParts.join(';');

    // Popup follows its feature; closes if the POI is gone.
    if (this.popupKey && this.popup) {
      const current = this.features.get(this.popupKey);
      if (!current) {
        this.popup.remove();
      } else {
        this.popup.setLngLat([current.lon, current.lat]);
        // The sprite may have changed (favorite / pause toggled from the menu).
        this.popup.setOffset(this.getPopupOffset(current));
      }
    }
    if (this.hoveredKey && !this.features.has(this.hoveredKey)) {
      this.setHovered(null);
    }

    if (!this.ensureLayers()) return;
    this.scheduleRaise();
    const source = this.map.getSource(POI_GPU_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    if (this.renderedSignature === this.dataSignature) return;
    this.dataSignature = this.renderedSignature;
    source.setData(this.data);
  }

  private openPopup(key: string, feature: PoiFeature): void {
    this.popup?.remove();

    const popup = new mapboxgl.Popup({
      className: 'rv-poi-popup',
      closeButton: false,
      closeOnClick: true,
      focusAfterOpen: false,
      maxWidth: 'none',
      offset: this.getPopupOffset(feature),
    });

    // Popup DOM is built on open only — a single popup exists at a time.
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

    popup.on('close', () => {
      if (this.popup === popup) {
        this.popup = null;
        this.popupKey = null;
      }
    });

    this.popup = popup;
    this.popupKey = key;
    keepPopupInVisibleMap(popup, this.map);
    popup.setLngLat([feature.lon, feature.lat]).addTo(this.map);
    this.getActions().onSelectPoi?.(feature);
  }

  /**
   * Popup offset keeping the menu clear of what the sprite really draws, on
   * whichever side Mapbox anchors it (the hovered sprite is scaled and
   * lifted: included).
   */
  private getPopupOffset(feature: PoiFeature) {
    const size = getIconSizeAtZoom(this.map.getZoom()) * HOVER_SCALE;
    const bounds = this.sprites.get(getPoiSpriteId(getPoiSpriteSpec(feature)))?.hitMask.bounds;
    const fallback = FALLBACK_HALF_EXTENT_PX;
    return buildPopupClearanceOffset({
      above: (bounds ? Math.max(0, -bounds.minY) : fallback) * size + HOVER_LIFT_PX,
      below: (bounds ? Math.max(0, bounds.maxY) : fallback) * size,
      side: (bounds ? Math.max(-bounds.minX, bounds.maxX, 0) : fallback) * size,
    });
  }

  private setHovered(key: string | null): void {
    setMapCursor(this.map, POI_CURSOR_OWNER, key ? 'pointer' : null, MAP_CURSOR_PRIORITY.hover);
    if (key === this.hoveredKey) return;
    const map = this.map;
    try {
      if (this.hoveredKey && map.getSource(POI_GPU_SOURCE_ID)) {
        map.setFeatureState({ source: POI_GPU_SOURCE_ID, id: this.hoveredKey }, { hover: false });
      }
      this.hoveredKey = key;
      if (key && map.getSource(POI_GPU_SOURCE_ID)) {
        map.setFeatureState({ source: POI_GPU_SOURCE_ID, id: key }, { hover: true });
      }
      if (map.getLayer(POI_GPU_HOVER_LAYER_ID)) {
        map.setFilter(POI_GPU_HOVER_LAYER_ID, ['==', ['get', 'key'], key ?? '']);
      }
    } catch {
      this.hoveredKey = key;
    }
  }

  /**
   * Keep the POI layers at the very top of the stack: route lines (and other
   * overlays) are added / re-added after us and would otherwise paint over
   * the icons. Only moves when needed, so the `styledata` it triggers is a no-op.
   */
  private raiseLayers(): void {
    const map = this.map;
    try {
      if (!map.getLayer(POI_GPU_LAYER_ID) || !map.getLayer(POI_GPU_HOVER_LAYER_ID)) return;
      const order = (map as unknown as { style?: { order?: string[] } }).style?.order;
      if (!order || order.length < 2) return;
      const last = order[order.length - 1];
      const beforeLast = order[order.length - 2];
      if (beforeLast === POI_GPU_LAYER_ID && last === POI_GPU_HOVER_LAYER_ID) return;
      map.moveLayer(POI_GPU_LAYER_ID);
      map.moveLayer(POI_GPU_HOVER_LAYER_ID);
    } catch {
      // Style mid-reload.
    }
  }

  private readonly scheduleRaise = (): void => {
    if (this.raiseFrameId != null || this.destroyed) return;
    this.raiseFrameId = window.requestAnimationFrame(() => {
      this.raiseFrameId = null;
      if (!this.destroyed) this.raiseLayers();
    });
  };

  private readonly handleStyleData = (): void => {
    if (this.destroyed) return;
    let missing = false;
    try {
      missing = !this.map.getLayer(POI_GPU_LAYER_ID) || !this.map.getSource(POI_GPU_SOURCE_ID);
    } catch {
      return;
    }
    if (!missing) {
      this.scheduleRaise();
      return;
    }
    // A style reload wiped source, layers and images: reinstall everything.
    this.dataSignature = '';
    if (this.ensureLayers()) {
      (this.map.getSource(POI_GPU_SOURCE_ID) as GeoJSONSource | undefined)?.setData(this.data);
      this.dataSignature = this.renderedSignature;
    }
  };

  private readonly handleZoom = (): void => {
    if (!this.popup || this.zoomFrameId != null) return;
    this.zoomFrameId = window.requestAnimationFrame(() => {
      this.zoomFrameId = null;
      const feature = this.popupKey ? this.features.get(this.popupKey) : undefined;
      if (feature) this.popup?.setOffset(this.getPopupOffset(feature));
    });
  };

  private readonly handleMapMouseDown = (): void => {
    this.pressedOpenPopupKey = this.popup?.isOpen() ? this.popupKey : null;
  };

  private readonly handleMapClick = (event: MapMouseEvent): void => {
    // Un marqueur DOM (waypoint, pause, départ…) posé sur le POI gère son
    // propre clic : sans ça, les deux panneaux s'ouvraient ensemble.
    if (isEventFromDomMarker(event)) {
      this.pressedOpenPopupKey = null;
      return;
    }
    const key = this.queryKeyAt(event.point, 0);
    const feature = key ? this.features.get(key) : undefined;
    const pressedOpenKey = this.pressedOpenPopupKey;
    this.pressedOpenPopupKey = null;
    if (!key || !feature) return;
    // Second clic sur le POI dont le panneau est ouvert : il se ferme, comme
    // un clic ailleurs sur la carte.
    if (key === pressedOpenKey) {
      this.popup?.remove();
      return;
    }
    this.openPopup(key, feature);
  };

  /** Hover, resolved once per frame on the last pointer position. */
  private readonly handleMapMouseMove = (event: MapMouseEvent): void => {
    if (this.destroyed) return;
    if (this.suppressed || isEventFromDomMarker(event)) {
      this.hoverPoint = null;
      this.setHovered(null);
      return;
    }
    // Button held: a pan or a drag owns the pointer, the hover stays as is.
    if ((event.originalEvent as MouseEvent | undefined)?.buttons) return;
    this.hoverPoint = { x: event.point.x, y: event.point.y };
    if (this.hoverFrameId != null) return;
    this.hoverFrameId = window.requestAnimationFrame(() => {
      this.hoverFrameId = null;
      const point = this.hoverPoint;
      if (!point || this.destroyed || this.map.isMoving()) return;
      this.setHovered(this.queryKeyAt(point, 0));
    });
  };

  private readonly handleMapMouseOut = (): void => {
    this.hoverPoint = null;
    this.setHovered(null);
  };
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
