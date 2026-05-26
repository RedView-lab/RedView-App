import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';
import type { PoiCategory, PoiFeature, GpxRoute } from '../types';
import { fetchPoisAlongRouteChunked } from '../lib/poi-api';
import { sampleRouteByDistance } from '../lib/gpx-loader';
import { registerPoiIcons, resetIconRegistration } from '../lib/poi-icons';
import { refinePoiFeaturesAlongRoute } from '../lib/refine-corridor-pois';

// ── Constants ─────────────────────────────────────────────────────────

const SOURCE_ID = 'poi-source';
const LAYER_ID = 'poi-layer';
const TEXT_LAYER_ID = 'poi-text-layer';

function canMutateStyle(map: MapboxMap): boolean {
  try {
    return map.isStyleLoaded() && Boolean(map.getStyle());
  } catch {
    return false;
  }
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconsReady = useRef(false);
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

  // ── Setup source + layers ─────────────────────────────────────────

  const ensureSourceAndLayers = useCallback((m: MapboxMap): boolean => {
    if (!canMutateStyle(m)) return false;
    if (!m.getSource(SOURCE_ID)) {
      m.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    if (!m.getLayer(LAYER_ID)) {
      m.addLayer({
        id: LAYER_ID,
        type: 'symbol',
        source: SOURCE_ID,
        slot: 'top',
        layout: {
          'icon-image': ['concat', 'poi-', ['get', 'category']],
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            8, 0.5,
            12, 0.7,
            16, 1.0,
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-padding': 2,
          'icon-pitch-alignment': 'viewport',
          'icon-rotation-alignment': 'viewport',
          'symbol-z-elevate': true,
          'symbol-sort-key': ['match', ['get', 'category'],
            'hospital', 0,
            'pharmacy', 1,
            'drinking_water', 2,
            'bicycle_repair', 3,
            'bicycle', 4,
            'bakery', 5,
            'supermarket', 6,
            'convenience', 7,
            'toilets', 8,
            'shelter', 9,
            'camp_site', 10,
            99,
          ],
        },
      });
    }

    if (!m.getLayer(TEXT_LAYER_ID)) {
      m.addLayer({
        id: TEXT_LAYER_ID,
        type: 'symbol',
        source: SOURCE_ID,
        slot: 'top',
        minzoom: 14,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-optional': true,
          'text-allow-overlap': false,
          'text-pitch-alignment': 'viewport',
          'text-rotation-alignment': 'viewport',
          'symbol-z-elevate': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0,0,0,0.7)',
          'text-halo-width': 1,
        },
      });
    }
    return true;
  }, []);

  // ── Update GeoJSON data ───────────────────────────────────────────

  const updateSourceData = useCallback((m: MapboxMap, features: PoiFeature[]) => {
    if (!canMutateStyle(m)) return;
    const source = m.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: features.map((f) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [f.lon, f.lat] },
        properties: {
          id: f.id,
          category: f.category,
          name: f.name ?? '',
          opening_hours: f.tags.opening_hours ?? '',
        },
      })),
    };

    source.setData(geojson);
    setPoiCount(features.length);
  }, []);

  // ── Corridor fetch (along GPX route, chunked & progressive) ──────

  const fetchCorridorPois = useCallback(async (m: MapboxMap) => {
    const route = gpxRef.current;
    const cats = Array.from(enabledRef.current);
    if (!route || cats.length === 0) {
      updateSourceData(m, []);
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
          const refined = applyRefinement(deduped);
          lastCorridorFeatures.current = refined;
          updateSourceData(m, refined);
          onCorridorUpdateRef.current?.(refined);
          setCorridorProgress(total > 0 ? done / total : 0);
        },
      });
      if (!controller.signal.aborted) {
        const refined = applyRefinement(features);
        lastCorridorFeatures.current = refined;
        updateSourceData(m, refined);
        onCorridorCompleteRef.current?.(refined);
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
  }, [updateSourceData]);

  // ── Public trigger for corridor search ────────────────────────────

  const searchCorridor = useCallback(() => {
    if (map && isMapLoaded && iconsReady.current && gpxRef.current) {
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

  // ── Popup on click ────────────────────────────────────────────────

  const popupRef = useRef<mapboxgl.Popup | null>(null);

  const handleClick = useCallback((e: mapboxgl.MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature || feature.geometry.type !== 'Point') return;

    const coords = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
    const props = feature.properties ?? {};
    const name = props.name || 'Sans nom';
    const category = props.category ?? '';
    const hours = props.opening_hours ?? '';

    popupRef.current?.remove();
    popupRef.current = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: '220px',
      offset: 12,
    })
      .setLngLat(coords)
      .setHTML(
        `<div style="font:13px/1.4 system-ui;color:#fff">
          <strong>${escapeHtml(name)}</strong>
          <div style="opacity:0.7;font-size:11px;margin-top:2px">${escapeHtml(category.replace(/_/g, ' '))}</div>
          ${hours ? `<div style="margin-top:4px;font-size:11px">🕐 ${escapeHtml(hours)}</div>` : ''}
        </div>`,
      )
      .addTo(e.target);
  }, []);

  // ── Cursor change on hover ────────────────────────────────────────

  const handleMouseEnter = useCallback(() => {
    if (map) map.getCanvas().style.cursor = 'pointer';
  }, [map]);

  const handleMouseLeave = useCallback(() => {
    if (map) map.getCanvas().style.cursor = '';
  }, [map]);

  // ── Main effect: setup & teardown ─────────────────────────────────

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let mounted = true;

    const setup = async () => {
      if (!iconsReady.current) {
        await registerPoiIcons(map);
        iconsReady.current = true;
      }

      if (!mounted) return;

      if (!ensureSourceAndLayers(map)) return;

      // Seed the POI source from a previously-saved corridor result
      // (rehydrated from Supabase) so the user doesn't have to re-click
      // "Charger" after reopening a project. Falls back to empty when
      // the active itinerary has never been searched.
      const seed = initialFeaturesRef.current ?? [];
      if (seed.length > 0) {
        const refinedSeed = applyRefinement(seed);
        lastCorridorFeatures.current = refinedSeed;
        updateSourceData(map, refinedSeed);
      } else {
        updateSourceData(map, []);
      }

      map.on('click', LAYER_ID, handleClick);
      map.on('mouseenter', LAYER_ID, handleMouseEnter);
      map.on('mouseleave', LAYER_ID, handleMouseLeave);

      return () => {
        map.off('click', LAYER_ID, handleClick);
        map.off('mouseenter', LAYER_ID, handleMouseEnter);
        map.off('mouseleave', LAYER_ID, handleMouseLeave);
      };
    };

    let cleanupListeners: (() => void) | undefined;

    setup().then((cleanup) => {
      if (mounted) cleanupListeners = cleanup;
    });

    return () => {
      mounted = false;
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      popupRef.current?.remove();
      cleanupListeners?.();

      try {
        if (map.getLayer(TEXT_LAYER_ID)) map.removeLayer(TEXT_LAYER_ID);
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch { /* map might be destroyed */ }

      resetIconRegistration();
      iconsReady.current = false;
    };
  }, [map, isMapLoaded, ensureSourceAndLayers, updateSourceData, handleClick, handleMouseEnter, handleMouseLeave, applyRefinement]);

  // ── Recover POI layers after style reloads ─────────────────────────
  // Standard Satellite fires style.load multiple times (imports/terrain),
  // which wipes custom sources, layers, and images.

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      // Defer so useMap's async handler (await swReady → addSource) completes first
      setTimeout(async () => {
        try {
          if (!canMutateStyle(map)) return;
          resetIconRegistration();
          iconsReady.current = false;
          await registerPoiIcons(map);
          iconsReady.current = true;

          if (!ensureSourceAndLayers(map)) return;

          if (gpxRef.current && lastCorridorFeatures.current.length > 0) {
            // Corridor mode: re-render last corridor results
            updateSourceData(map, applyRefinement(lastCorridorFeatures.current));
          } else {
            // No GPX or no prior corridor search → keep map empty
            updateSourceData(map, []);
          }
        } catch (err) {
          console.warn('[poi] style.load recovery failed:', err);
        }
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded, ensureSourceAndLayers, updateSourceData, applyRefinement]);

  // ── Re-fetch when enabled categories change (corridor mode only) ──

  useEffect(() => {
    if (!map || !isMapLoaded || !iconsReady.current) return;
    // POIs are corridor-only now: viewport auto-fetch removed.
    // The user must explicitly press the search button after loading a GPX.
    if (gpxRef.current && lastCorridorFeatures.current.length > 0) {
      // Re-run corridor search if a previous search exists, so toggling
      // categories updates the visible POIs along the route.
      fetchCorridorPois(map);
    }
  }, [map, isMapLoaded, enabledCategoriesKey, refineKey, fetchCorridorPois]);

  // ── Rehydrate from saved features when active itinerary changes ───
  // Switching itineraries (or initially loading a project from Supabase)
  // updates `initialFeatures` — we mirror it onto the shared POI source
  // so each itinerary's persisted markers reappear without a re-search.
  useEffect(() => {
    if (!map || !isMapLoaded || !iconsReady.current) return;
    const seed = initialFeaturesRef.current ?? [];
    const refinedSeed = applyRefinement(seed);
    lastCorridorFeatures.current = refinedSeed;
    updateSourceData(map, refinedSeed);
  }, [map, isMapLoaded, initialFeaturesKey, updateSourceData, applyRefinement]);

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
