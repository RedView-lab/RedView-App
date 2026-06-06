import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';
import { POI_LABELS, type PoiCategory, type PoiFeature, type GpxRoute } from '../types';
import { fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { sampleRouteByDistance } from '../lib/gpx-loader';
import { getPoiIconUrl, hasDedicatedFavoritePoiIcon } from '../lib/poi-icons';
import { refinePoiFeaturesAlongRoute } from '../lib/refine-corridor-pois';
import '../styles/floating-markers.css';

// ── Constants ─────────────────────────────────────────────────────────

const MARKER_MIN_SCALE_ZOOM = 8.25;
const MARKER_MAX_SCALE_ZOOM = 15.1;
const MARKER_MIN_SCREEN_SCALE = 0.42;
const MARKER_MAX_SCREEN_SCALE = 1;
const MARKER_MIN_LIFT_M = 7;
const MARKER_MAX_LIFT_M = 10.5;
const MARKER_MIN_POPUP_OFFSET_PX = 26;
const MARKER_MAX_POPUP_OFFSET_PX = 34;

const UI_ICON_URLS = {
  rightClick: '/right-click-icons',
  star: '/svgv2/icone/star-01.svg',
  globe: '/right-click-icons/globe-06.svg',
  chevron: '/svgv2/icone/chevron-down.svg',
  check: '/svgv2/icone/check.svg',
  trash: '/right-click-icons/trash-01.svg',
} as const;

interface PoiMarkerEntry {
  marker: mapboxgl.Marker;
  popup: mapboxgl.Popup;
  signature: string;
}

interface PoiMarkerVisualState {
  scale: number;
  altitude: number;
  popupOffsetPx: number;
}

export interface PoiPopupState {
  favoriteEnabled: boolean;
  pauseEnabled: boolean;
  pauseDurationMin: number;
  manualTraceEnabled: boolean;
}

export interface UsePoiPopupActions {
  getPopupState?: (feature: PoiFeature) => PoiPopupState;
  onStartHere?: (feature: PoiFeature) => void;
  onAddWaypoint?: (feature: PoiFeature) => void;
  onFinishHere?: (feature: PoiFeature) => void;
  onCyclePauseDuration?: (feature: PoiFeature) => void;
  onToggleFavorite?: (feature: PoiFeature, nextEnabled: boolean) => void;
  onTogglePause?: (
    feature: PoiFeature,
    nextEnabled: boolean,
    durationMin: number,
  ) => void;
  onToggleManualTrace?: (feature: PoiFeature, nextEnabled: boolean) => void;
  onOpenStreetView?: (feature: PoiFeature) => void;
  onDelete?: (feature: PoiFeature) => void;
}

const DEFAULT_POPUP_STATE: PoiPopupState = {
  favoriteEnabled: false,
  pauseEnabled: false,
  pauseDurationMin: 5,
  manualTraceEnabled: false,
};

function getMarkerKey(feature: PoiFeature): string {
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

function createMarkerElement(feature: PoiFeature): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'rv-poi-marker';
  if (feature.favorite && !hasDedicatedFavoritePoiIcon(feature.category)) {
    element.classList.add('is-favorite-fallback');
  }
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

  if (feature.favorite && !hasDedicatedFavoritePoiIcon(feature.category)) {
    const badge = document.createElement('span');
    badge.className = 'rv-poi-marker__favorite-badge';
    badge.setAttribute('aria-hidden', 'true');

    const badgeIcon = document.createElement('img');
    badgeIcon.className = 'rv-poi-marker__favorite-badge-icon';
    badgeIcon.src = UI_ICON_URLS.star;
    badgeIcon.alt = '';
    badgeIcon.draggable = false;
    badge.appendChild(badgeIcon);

    element.appendChild(badge);
  }

  return element;
}

function buildPopupHtml(feature: PoiFeature, state: PoiPopupState): string {
  const name = feature.name?.trim() || 'Sans nom';
  const category = POI_LABELS[feature.category] ?? feature.category.replace(/_/g, ' ');
  const pauseDurationLabel = formatPauseDuration(state.pauseDurationMin);

  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <button
          type="button"
          class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost${state.favoriteEnabled ? ' is-active' : ''}"
          aria-label="Favori"
          aria-pressed="${state.favoriteEnabled}"
          data-action="favorite-toggle"
        >
          <img src="${UI_ICON_URLS.star}" alt="" class="rv-poi-popup__icon rv-poi-popup__icon--star" />
        </button>
        <div class="rv-poi-popup__title">${escapeHtml(name)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="Ouvrir Street View" data-action="streetview">
          <img src="${UI_ICON_URLS.globe}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">Type</div>
        <div class="rv-poi-popup__select" aria-label="Type de POI" role="presentation">
          <span class="rv-poi-popup__type-icon-wrap">
            <img src="${getPoiIconUrl(feature.category, state.favoriteEnabled)}" alt="" class="rv-poi-popup__type-icon" />
          </span>
          <span class="rv-poi-popup__select-value">${escapeHtml(category)}</span>
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row rv-poi-popup__field-row--compact">
        <button type="button" class="rv-poi-popup__toggle-wrap rv-poi-popup__toggle-wrap--button" data-action="pause-toggle" aria-pressed="${state.pauseEnabled}">
          <span class="rv-poi-popup__checkbox${state.pauseEnabled ? ' is-active' : ''}">
            <img src="${UI_ICON_URLS.check}" alt="" class="rv-poi-popup__checkbox-icon" />
          </span>
          <span class="rv-poi-popup__toggle-label">Pause</span>
        </button>
        <button type="button" class="rv-poi-popup__select rv-poi-popup__select--duration" aria-label="Durée de pause" data-action="pause-duration">
          <span class="rv-poi-popup__select-value">${pauseDurationLabel}</span>
          <img src="${UI_ICON_URLS.chevron}" alt="" class="rv-poi-popup__chevron" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__toggle-row rv-poi-popup__toggle-row--button" data-action="manual-trace" aria-pressed="${state.manualTraceEnabled}">
        <span class="rv-poi-popup__checkbox${state.manualTraceEnabled ? ' is-active' : ''}">
          <img src="${UI_ICON_URLS.check}" alt="" class="rv-poi-popup__checkbox-icon" />
        </span>
        <span class="rv-poi-popup__toggle-label rv-poi-popup__toggle-label--solid">Tracé manuel</span>
      </button>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__action-row" data-action="start-here">
        <span class="rv-poi-popup__action-icon-wrap" aria-hidden="true">
          <img src="${UI_ICON_URLS.rightClick}/start.svg" alt="" class="rv-poi-popup__action-icon rv-poi-popup__action-icon--pin" />
        </span>
        <span class="rv-poi-popup__action-label">Démarrer ici</span>
      </button>

      <button type="button" class="rv-poi-popup__action-row" data-action="add-waypoint">
        <span class="rv-poi-popup__action-icon-wrap" aria-hidden="true">
          <img src="${UI_ICON_URLS.rightClick}/ajouteruneetape.svg" alt="" class="rv-poi-popup__action-icon rv-poi-popup__action-icon--pin" />
        </span>
        <span class="rv-poi-popup__action-label">Ajouter une étape</span>
      </button>

      <button type="button" class="rv-poi-popup__action-row" data-action="finish-here">
        <span class="rv-poi-popup__action-icon-wrap" aria-hidden="true">
          <img src="${UI_ICON_URLS.rightClick}/finish.svg" alt="" class="rv-poi-popup__action-icon rv-poi-popup__action-icon--pin" />
        </span>
        <span class="rv-poi-popup__action-label">Finir ici</span>
      </button>

      <button type="button" class="rv-poi-popup__action-row rv-poi-popup__action-row--delete" data-action="delete">
        <span class="rv-poi-popup__utility-icon-wrap">
          <img src="${UI_ICON_URLS.trash}" alt="" class="rv-poi-popup__utility-icon" />
        </span>
        <span class="rv-poi-popup__action-label rv-poi-popup__action-label--delete">Supprimer</span>
      </button>
    </div>
  `;
}

function buildPopupContent(
  feature: PoiFeature,
  state: PoiPopupState,
  actions: UsePoiPopupActions,
  refresh: (nextState?: PoiPopupState) => void,
): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = buildPopupHtml(feature, state);
  const panel = root.firstElementChild;
  if (!(panel instanceof HTMLDivElement)) {
    return document.createElement('div');
  }

  const bindClick = (
    selector: string,
    handler: () => void,
  ) => {
    for (const node of panel.querySelectorAll<HTMLButtonElement>(selector)) {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler();
      });
    }
  };

  bindClick('[data-action="streetview"]', () => {
    actions.onOpenStreetView?.(feature);
  });

  bindClick('[data-action="favorite-toggle"]', () => {
    const nextState = {
      ...state,
      favoriteEnabled: !state.favoriteEnabled,
    };
    actions.onToggleFavorite?.(feature, nextState.favoriteEnabled);
    refresh(nextState);
  });

  bindClick('[data-action="pause-toggle"]', () => {
    const nextState = {
      ...state,
      pauseEnabled: !state.pauseEnabled,
    };
    actions.onTogglePause?.(feature, nextState.pauseEnabled, nextState.pauseDurationMin);
    refresh(nextState);
  });

  bindClick('[data-action="pause-duration"]', () => {
    actions.onCyclePauseDuration?.(feature);
  });

  bindClick('[data-action="manual-trace"]', () => {
    const nextState = {
      ...state,
      manualTraceEnabled: !state.manualTraceEnabled,
    };
    actions.onToggleManualTrace?.(feature, nextState.manualTraceEnabled);
    refresh(nextState);
  });

  bindClick('[data-action="start-here"]', () => {
    actions.onStartHere?.(feature);
  });

  bindClick('[data-action="add-waypoint"]', () => {
    actions.onAddWaypoint?.(feature);
  });

  bindClick('[data-action="finish-here"]', () => {
    actions.onFinishHere?.(feature);
  });

  bindClick('[data-action="delete"]', () => {
    actions.onDelete?.(feature);
  });

  return panel;
}

function resolvePopupState(
  actions: UsePoiPopupActions,
  feature: PoiFeature,
  nextState?: PoiPopupState,
): PoiPopupState {
  return {
    ...DEFAULT_POPUP_STATE,
    ...(actions.getPopupState?.(feature) ?? {}),
    ...(nextState ?? {}),
  };
}

function getPoiMarkerVisualState(zoom: number): PoiMarkerVisualState {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  const scale = lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress);

  return {
    scale,
    altitude: lerp(MARKER_MAX_LIFT_M, MARKER_MIN_LIFT_M, progress),
    popupOffsetPx: Math.round(
      lerp(MARKER_MIN_POPUP_OFFSET_PX, MARKER_MAX_POPUP_OFFSET_PX, progress),
    ),
  };
}

function applyPoiMarkerVisualState(
  marker: mapboxgl.Marker,
  popup: mapboxgl.Popup,
  zoom: number,
): void {
  const visualState = getPoiMarkerVisualState(zoom);
  marker.getElement().style.setProperty(
    '--rv-poi-marker-scale',
    visualState.scale.toFixed(3),
  );
  marker.setAltitude(visualState.altitude);
  popup.setAltitude(visualState.altitude);
  popup.setOffset(visualState.popupOffsetPx);
}

function createPoiMarker(
  map: MapboxMap,
  feature: PoiFeature,
  actions: UsePoiPopupActions,
): PoiMarkerEntry {
  const popup = new mapboxgl.Popup({
    className: 'rv-poi-popup',
    closeButton: false,
    closeOnClick: true,
    focusAfterOpen: false,
    maxWidth: 'none',
    offset: MARKER_MAX_POPUP_OFFSET_PX,
    altitude: MARKER_MIN_LIFT_M,
  });

  const refresh = (nextState?: PoiPopupState) => {
    popup.setDOMContent(buildPopupContent(
      feature,
      resolvePopupState(actions, feature, nextState),
      actions,
      refresh,
    ));
  };

  refresh();

  popup.on('open', () => {
    refresh();
  });

  const marker = new mapboxgl.Marker({
    element: createMarkerElement(feature),
    anchor: 'bottom',
    pitchAlignment: 'viewport',
    rotationAlignment: 'viewport',
    occludedOpacity: 0,
    altitude: MARKER_MIN_LIFT_M,
  })
    .setLngLat([feature.lon, feature.lat])
    .setPopup(popup)
    .addTo(map);

  applyPoiMarkerVisualState(marker, popup, map.getZoom());

  return {
    marker,
    popup,
    signature: getMarkerSignature(feature),
  };
}

// ── Hook ──────────────────────────────────────────────────────────────

export function usePoi(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabledCategories: Set<PoiCategory>,
  gpxRoute: GpxRoute | null = null,
  radiusM: number = 1000,
  refineMaxPerCategoryPerKm: number | null = null,
  onCorridorUpdate?: (features: PoiFeature[]) => void,
  onCorridorComplete?: (features: PoiFeature[]) => void,
  /**
   * Pre-loaded POI features to render immediately (e.g. rehydrated from
   * a saved project). Seeds `lastCorridorFeatures` so map/style reloads
   * and itinerary switches restore the markers without re-running the
   * corridor search.
   */
  initialFeatures: PoiFeature[] | null = null,
  popupActions: UsePoiPopupActions = {},
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poiCount, setPoiCount] = useState(0);
  /** 0..1 progress for corridor fetches; null when not running. */
  const [corridorProgress, setCorridorProgress] = useState<number | null>(
    null,
  );

  const abortRef = useRef<AbortController | null>(null);
  const markerRegistryRef = useRef<Map<string, PoiMarkerEntry>>(new Map());
  const enabledRef = useRef(enabledCategories);
  enabledRef.current = enabledCategories;
  const enabledCategoriesKey = Array.from(enabledCategories).sort().join('|');
  const refineKey = refineMaxPerCategoryPerKm
    ? String(refineMaxPerCategoryPerKm)
    : 'off';
  const gpxRef = useRef(gpxRoute);
  gpxRef.current = gpxRoute;
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;
  const refineMaxRef = useRef(refineMaxPerCategoryPerKm);
  refineMaxRef.current = refineMaxPerCategoryPerKm;
  const lastCorridorFeatures = useRef<PoiFeature[]>([]);
  const onCorridorUpdateRef = useRef(onCorridorUpdate);
  onCorridorUpdateRef.current = onCorridorUpdate;
  const onCorridorCompleteRef = useRef(onCorridorComplete);
  onCorridorCompleteRef.current = onCorridorComplete;
  const popupActionsRef = useRef<UsePoiPopupActions>(popupActions);
  popupActionsRef.current = popupActions;

  // Track the active itinerary's pre-loaded features (from Supabase). A
  // change in identity/length/first/last id indicates an itinerary switch
  // or a freshly-rehydrated project, prompting a rehydration of the
  // shared POI source.
  const initialFeaturesRef = useRef<PoiFeature[] | null>(initialFeatures);
  initialFeaturesRef.current = initialFeatures;
  const initialFeaturesKey = initialFeatures && initialFeatures.length > 0
    ? initialFeatures.map((feature) => [
      feature.id,
      feature.category,
      feature.favorite ? '1' : '0',
      feature.lat,
      feature.lon,
    ].join(':')).join('|')
    : 'empty';

  const applyRefinement = useCallback((features: PoiFeature[]) => {
    const route = gpxRef.current;
    const maxPerCategoryPerKm = refineMaxRef.current;
    if (!route || !maxPerCategoryPerKm) return features;
    return refinePoiFeaturesAlongRoute(features, route.points, {
      maxPerCategoryPerKm,
      windowM: 1_000,
    });
  }, []);

  const buildRenderableFeatures = useCallback((features: PoiFeature[]) => {
    if (features.length === 0 || enabledRef.current.size === 0) return [];

    const filtered = features.filter((feature) => enabledRef.current.has(feature.category));
    if (filtered.length === 0) return [];

    return applyRefinement(filtered);
  }, [applyRefinement]);

  const clearMarkers = useCallback(() => {
    for (const { marker } of markerRegistryRef.current.values()) {
      marker.remove();
    }
    markerRegistryRef.current.clear();
    setPoiCount(0);
  }, []);

  const syncMarkerVisualState = useCallback((m: MapboxMap) => {
    const zoom = m.getZoom();
    for (const { marker, popup } of markerRegistryRef.current.values()) {
      applyPoiMarkerVisualState(marker, popup, zoom);
    }
  }, []);

  const syncRenderedFeatures = useCallback((m: MapboxMap, features: PoiFeature[]) => {
    const registry = markerRegistryRef.current;
    const nextKeys = new Set(features.map(getMarkerKey));

    for (const [key, entry] of registry) {
      if (nextKeys.has(key)) continue;
      entry.marker.remove();
      registry.delete(key);
    }

    for (const feature of features) {
      const key = getMarkerKey(feature);
      const signature = getMarkerSignature(feature);
      const existing = registry.get(key);

      if (existing && existing.signature === signature) {
        continue;
      }

      existing?.marker.remove();
      registry.set(key, createPoiMarker(m, feature, popupActionsRef.current));
    }

    setPoiCount(features.length);
  }, []);

  // ── Corridor fetch (along GPX route, chunked & progressive) ──────

  const fetchCorridorPois = useCallback(async (m: MapboxMap) => {
    const route = gpxRef.current;
    const cats = Array.from(enabledRef.current);
    if (!route || cats.length === 0) {
      lastCorridorFeatures.current = [];
      syncRenderedFeatures(m, []);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setCorridorProgress(0);

    // Spacing chosen so consecutive Overpass `around:r` disks overlap
    // (no gaps in the corridor). Three constraints:
    //   1. spacing >= radius * 1.6  → adjacent disks overlap.
    //   2. spacing >= 200 m         → tiny user radii still produce a
    //      reasonable sample count (avoids 10 000+ samples for 40 m).
    //   3. spacing chosen so total samples never exceed ~1500          →
    //      caps the number of sequential Overpass chunks for huge GPX
    //      routes (e.g. multi-day alpine tours) at ~20 calls.
    const radius = radiusRef.current;
    let approxLenM = 0;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      const dLat = (b.lat - a.lat) * 111_320;
      const dLon =
        (b.lon - a.lon) *
        111_320 *
        Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
      approxLenM += Math.sqrt(dLat * dLat + dLon * dLon);
    }
    const lenBasedSpacing = approxLenM > 0 ? approxLenM / 1_500 : 0;
    const spacing = Math.max(200, radius * 1.6, lenBasedSpacing);
    const sampled = sampleRouteByDistance(route.points, spacing, 8_000);

    try {
      const features = await fetchPoisAlongRouteChunked({
        samples: sampled,
        radiusM: radius,
        categories: cats,
        signal: controller.signal,
        onProgress: (deduped, { done, total }) => {
          if (controller.signal.aborted) return;
          const rendered = buildRenderableFeatures(deduped);
          lastCorridorFeatures.current = rendered;
          syncRenderedFeatures(m, rendered);
          onCorridorUpdateRef.current?.(rendered);
          setCorridorProgress(total > 0 ? done / total : 0);
        },
      });
      if (!controller.signal.aborted) {
        const rendered = buildRenderableFeatures(features);
        lastCorridorFeatures.current = rendered;
        syncRenderedFeatures(m, rendered);
        onCorridorCompleteRef.current?.(rendered);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Erreur POI corridor');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setCorridorProgress(null);
      }
    }
  }, [buildRenderableFeatures, syncRenderedFeatures]);

  // ── Public trigger for corridor search ────────────────────────────

  const searchCorridor = useCallback(() => {
    if (map && isMapLoaded && gpxRef.current) {
      fetchCorridorPois(map);
    }
  }, [map, isMapLoaded, fetchCorridorPois]);

  const cancelSearchCorridor = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setCorridorProgress(null);
    setError(null);
  }, []);

  // ── Main effect: setup & teardown ─────────────────────────────────

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const seed = buildRenderableFeatures(initialFeaturesRef.current ?? []);
    lastCorridorFeatures.current = seed;
    syncRenderedFeatures(map, seed);

    return () => {
      abortRef.current?.abort();
      clearMarkers();
    };
  }, [map, isMapLoaded, buildRenderableFeatures, syncRenderedFeatures, clearMarkers]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let frameId: number | null = null;

    const scheduleVisualRefresh = () => {
      if (frameId != null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncMarkerVisualState(map);
      });
    };

    scheduleVisualRefresh();
    map.on('zoom', scheduleVisualRefresh);

    return () => {
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
      map.off('zoom', scheduleVisualRefresh);
    };
  }, [map, isMapLoaded, syncMarkerVisualState]);

  // ── Re-fetch when enabled categories change (corridor mode only) ──

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (gpxRef.current && lastCorridorFeatures.current.length > 0) {
      fetchCorridorPois(map);
      return;
    }

    syncRenderedFeatures(map, buildRenderableFeatures(initialFeaturesRef.current ?? []));
  }, [map, isMapLoaded, enabledCategoriesKey, refineKey, fetchCorridorPois, buildRenderableFeatures, syncRenderedFeatures]);

  // ── Rehydrate from saved features when active itinerary changes ───
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const seed = buildRenderableFeatures(initialFeaturesRef.current ?? []);
    lastCorridorFeatures.current = seed;
    syncRenderedFeatures(map, seed);
  }, [map, isMapLoaded, initialFeaturesKey, buildRenderableFeatures, syncRenderedFeatures]);

  return { loading, error, poiCount, corridorProgress, searchCorridor, cancelSearchCorridor };
}

// ── Helpers ───────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPauseDuration(durationMin: number): string {
  const safeDuration = Math.max(1, Math.round(durationMin || 5));
  return `${safeDuration} min`;
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
