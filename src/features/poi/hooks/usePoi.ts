import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';
import { POI_LABELS, type PoiCategory, type PoiFeature, type GpxRoute } from '../types';
import { fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { sampleRouteByDistance } from '../lib/gpx-loader';
import { getPoiIconUrl } from '../lib/poi-icons';
import { refinePoiFeaturesAlongRoute } from '../lib/refine-corridor-pois';
import '../styles/floating-markers.css';

// ── Constants ─────────────────────────────────────────────────────────

const MARKER_LIFT_M = 18;
const MARKER_POPUP_OFFSET_PX = 18;

interface PoiMarkerEntry {
  marker: mapboxgl.Marker;
  signature: string;
}

function getMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

function getMarkerSignature(feature: PoiFeature): string {
  return [
    feature.lat,
    feature.lon,
    feature.category,
    feature.name ?? '',
    feature.tags.opening_hours ?? '',
  ].join('|');
}

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
  image.src = getPoiIconUrl(feature.category);
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';

  element.appendChild(image);
  return element;
}

function buildPopupHtml(feature: PoiFeature): string {
  const name = feature.name?.trim() || 'Sans nom';
  const category = POI_LABELS[feature.category] ?? feature.category.replace(/_/g, ' ');
  const hours = feature.tags.opening_hours?.trim() || '';

  return `<div style="font:13px/1.4 system-ui;color:#fff">
    <strong>${escapeHtml(name)}</strong>
    <div style="opacity:0.72;font-size:11px;margin-top:2px">${escapeHtml(category)}</div>
    ${hours ? `<div style="margin-top:4px;font-size:11px">${escapeHtml(`Horaires: ${hours}`)}</div>` : ''}
  </div>`;
}

function createPoiMarker(map: MapboxMap, feature: PoiFeature): mapboxgl.Marker {
  const popup = new mapboxgl.Popup({
    closeButton: true,
    closeOnClick: true,
    maxWidth: '240px',
    offset: MARKER_POPUP_OFFSET_PX,
    altitude: MARKER_LIFT_M,
  }).setHTML(buildPopupHtml(feature));

  return new mapboxgl.Marker({
    element: createMarkerElement(feature),
    anchor: 'bottom',
    pitchAlignment: 'viewport',
    rotationAlignment: 'viewport',
    occludedOpacity: 0.3,
    altitude: MARKER_LIFT_M,
  })
    .setLngLat([feature.lon, feature.lat])
    .setPopup(popup)
    .addTo(map);
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

  // Track the active itinerary's pre-loaded features (from Supabase). A
  // change in identity/length/first/last id indicates an itinerary switch
  // or a freshly-rehydrated project, prompting a rehydration of the
  // shared POI source.
  const initialFeaturesRef = useRef<PoiFeature[] | null>(initialFeatures);
  initialFeaturesRef.current = initialFeatures;
  const initialFeaturesKey = initialFeatures && initialFeatures.length > 0
    ? `${initialFeatures.length}:${initialFeatures[0].id}:${initialFeatures[initialFeatures.length - 1].id}`
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
      registry.set(key, {
        marker: createPoiMarker(m, feature),
        signature,
      });
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
