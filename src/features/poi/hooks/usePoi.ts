import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';
import type { PoiCategory, PoiFeature, GpxRoute } from '../types';
import { POI_CATEGORIES } from '../types';
import { fetchPoisInBbox, fetchPoisAlongRoute } from '../lib/overpass';
import { sampleRoutePoints } from '../lib/gpx-loader';
import {
  tileZoomForMapZoom,
  getTilesForBounds,
  tileKeyToString,
  tileToBbox,
  isTileCached,
  setCachedTile,
  collectFeatures,
} from '../lib/poi-cache';
import { registerPoiIcons, resetIconRegistration } from '../lib/poi-icons';

// ── Constants ─────────────────────────────────────────────────────────

const SOURCE_ID = 'poi-source';
const LAYER_ID = 'poi-layer';
const TEXT_LAYER_ID = 'poi-text-layer';
const DEBOUNCE_MS = 500;

// ── Hook ──────────────────────────────────────────────────────────────

export function usePoi(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabledCategories: Set<PoiCategory>,
  gpxRoute: GpxRoute | null = null,
  radiusM: number = 1000,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poiCount, setPoiCount] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconsReady = useRef(false);
  const enabledRef = useRef(enabledCategories);
  enabledRef.current = enabledCategories;
  const gpxRef = useRef(gpxRoute);
  gpxRef.current = gpxRoute;
  const radiusRef = useRef(radiusM);
  radiusRef.current = radiusM;
  const lastCorridorFeatures = useRef<PoiFeature[]>([]);

  // ── Setup source + layers ─────────────────────────────────────────

  const ensureSourceAndLayers = useCallback((m: MapboxMap) => {
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
          'icon-allow-overlap': false,
          'icon-ignore-placement': false,
          'icon-padding': 4,
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
  }, []);

  // ── Update GeoJSON data ───────────────────────────────────────────

  const updateSourceData = useCallback((m: MapboxMap, features: PoiFeature[]) => {
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

  // ── Fetch missing tiles ───────────────────────────────────────────

  const fetchVisiblePois = useCallback(async (m: MapboxMap) => {
    const cats = Array.from(enabledRef.current);
    if (cats.length === 0) {
      updateSourceData(m, []);
      return;
    }

    const bounds = m.getBounds();
    if (!bounds) return;
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();

    // Determine tile zoom level based on current map zoom
    const mapZoom = m.getZoom();
    const config = tileZoomForMapZoom(mapZoom);

    if (!config) {
      // Too zoomed out — still show whatever is cached from previous views
      updateSourceData(m, []);
      return;
    }

    const { tz, maxTiles } = config;
    const tiles = getTilesForBounds(south, west, north, east, tz, maxTiles);
    const allKeys = tiles.map(tileKeyToString);

    // Determine which tiles need fetching
    const missingTiles = tiles.filter((t) => !isTileCached(tileKeyToString(t), cats));

    if (missingTiles.length === 0) {
      updateSourceData(m, collectFeatures(allKeys, cats));
      return;
    }

    // Cancel previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      // Batch missing tiles into groups of ≤6 and merge each group into one bbox request
      const BATCH_SIZE = 6;
      for (let i = 0; i < missingTiles.length; i += BATCH_SIZE) {
        if (controller.signal.aborted) break;

        const batch = missingTiles.slice(i, i + BATCH_SIZE);

        // Compute merged bbox for this batch
        let mSouth = 90, mWest = 180, mNorth = -90, mEast = -180;
        for (const t of batch) {
          const [s, w, n, e] = tileToBbox(t);
          mSouth = Math.min(mSouth, s);
          mWest = Math.min(mWest, w);
          mNorth = Math.max(mNorth, n);
          mEast = Math.max(mEast, e);
        }

        const features = await fetchPoisInBbox(mSouth, mWest, mNorth, mEast, cats, controller.signal);

        // Distribute features into tile buckets for caching
        for (const t of batch) {
          const [s, w, n, e] = tileToBbox(t);
          const tileFeatures = features.filter(
            (f) => f.lat >= s && f.lat <= n && f.lon >= w && f.lon <= e,
          );
          setCachedTile(tileKeyToString(t), tileFeatures, [...POI_CATEGORIES]);
        }

        // Progressive render: update map after each batch
        if (!controller.signal.aborted) {
          updateSourceData(m, collectFeatures(allKeys, cats));
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Erreur POI');
      // Still show whatever is cached
      updateSourceData(m, collectFeatures(allKeys, cats));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [updateSourceData]);

  // ── Corridor fetch (along GPX route) ──────────────────────────────

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

    try {
      const sampled = sampleRoutePoints(route.points, 300);
      const features = await fetchPoisAlongRoute(sampled, radiusRef.current, cats, controller.signal);
      if (!controller.signal.aborted) {
        lastCorridorFeatures.current = features;
        updateSourceData(m, features);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Erreur POI corridor');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [updateSourceData]);

  // ── Public trigger for corridor search ────────────────────────────

  const searchCorridor = useCallback(() => {
    if (map && isMapLoaded && iconsReady.current && gpxRef.current) {
      fetchCorridorPois(map);
    }
  }, [map, isMapLoaded, fetchCorridorPois]);

  // ── Debounced handler ─────────────────────────────────────────────

  const debouncedFetch = useCallback((m: MapboxMap) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchVisiblePois(m), DEBOUNCE_MS);
  }, [fetchVisiblePois]);

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

      ensureSourceAndLayers(map);

      // In viewport mode, auto-fetch on map movements
      // In corridor mode, wait for explicit searchCorridor trigger
      if (!gpxRef.current) {
        fetchVisiblePois(map);

        const onMoveEnd = () => {
          // Guard: if GPX was loaded after this effect started, skip viewport fetch
          if (gpxRef.current) return;
          debouncedFetch(map);
        };
        map.on('moveend', onMoveEnd);

        map.on('click', LAYER_ID, handleClick);
        map.on('mouseenter', LAYER_ID, handleMouseEnter);
        map.on('mouseleave', LAYER_ID, handleMouseLeave);

        return () => {
          map.off('moveend', onMoveEnd);
          map.off('click', LAYER_ID, handleClick);
          map.off('mouseenter', LAYER_ID, handleMouseEnter);
          map.off('mouseleave', LAYER_ID, handleMouseLeave);
        };
      }

      // Corridor mode: no auto-fetch, but still register click/hover
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
  }, [map, isMapLoaded, ensureSourceAndLayers, fetchVisiblePois, debouncedFetch, handleClick, handleMouseEnter, handleMouseLeave]);

  // ── Recover POI layers after style reloads ─────────────────────────
  // Standard Satellite fires style.load multiple times (imports/terrain),
  // which wipes custom sources, layers, and images.

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      // Defer so useMap's async handler (await swReady → addSource) completes first
      setTimeout(async () => {
        try {
          resetIconRegistration();
          iconsReady.current = false;
          await registerPoiIcons(map);
          iconsReady.current = true;

          ensureSourceAndLayers(map);

          if (gpxRef.current && lastCorridorFeatures.current.length > 0) {
            // Corridor mode: re-render last corridor results
            updateSourceData(map, lastCorridorFeatures.current);
          } else if (!gpxRef.current) {
            // Viewport mode: re-fetch visible POIs
            fetchVisiblePois(map);
          }
        } catch (err) {
          console.warn('[poi] style.load recovery failed:', err);
        }
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded, ensureSourceAndLayers, updateSourceData, fetchVisiblePois]);

  // ── Re-fetch when enabled categories change (viewport mode only) ──

  useEffect(() => {
    if (!map || !isMapLoaded || !iconsReady.current) return;
    // In corridor mode the user triggers search manually via the button
    if (!gpxRef.current) {
      fetchVisiblePois(map);
    }
  }, [map, isMapLoaded, enabledCategories, fetchVisiblePois]);

  return { loading, error, poiCount, searchCorridor };
}

// ── Helpers ───────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
