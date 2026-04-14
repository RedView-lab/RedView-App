import { useEffect, useRef, useCallback, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import mapboxgl from 'mapbox-gl';
import type { PoiCategory, PoiFeature } from '../types';
import { POI_CATEGORIES } from '../types';
import { fetchPoisInBbox } from '../lib/overpass';
import {
  getTilesForBounds,
  tileKeyToString,
  tileToBbox,
  isTileCached,
  setCachedTile,
  collectFeatures,
  MAX_FETCH_SPAN,
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
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poiCount, setPoiCount] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconsReady = useRef(false);
  const enabledRef = useRef(enabledCategories);
  enabledRef.current = enabledCategories;

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

    // Skip if viewport too large
    if (north - south > MAX_FETCH_SPAN || east - west > MAX_FETCH_SPAN) {
      // Still show cached data if available
      const tiles = getTilesForBounds(south, west, north, east);
      const keys = tiles.map(tileKeyToString);
      const cached = collectFeatures(keys, cats);
      updateSourceData(m, cached);
      return;
    }

    const tiles = getTilesForBounds(south, west, north, east);
    const allKeys = tiles.map(tileKeyToString);

    // Determine which tiles need fetching (all categories fetched together)
    const missingTiles = tiles.filter((t) => !isTileCached(tileKeyToString(t), cats));

    if (missingTiles.length === 0) {
      // Everything cached — just update source
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
      // Fetch all missing tiles — batch into a single Overpass request by merging bboxes
      // For efficiency, if ≤4 missing tiles, merge into one bbox; otherwise fetch individually
      if (missingTiles.length <= 6) {
        // Merge into one bbox encompassing all missing tiles
        let mSouth = 90, mWest = 180, mNorth = -90, mEast = -180;
        for (const t of missingTiles) {
          const [s, w, n, e] = tileToBbox(t);
          mSouth = Math.min(mSouth, s);
          mWest = Math.min(mWest, w);
          mNorth = Math.max(mNorth, n);
          mEast = Math.max(mEast, e);
        }

        const features = await fetchPoisInBbox(mSouth, mWest, mNorth, mEast, cats, controller.signal);

        // Distribute features into tile buckets for caching
        for (const t of missingTiles) {
          const [s, w, n, e] = tileToBbox(t);
          const tileFeatures = features.filter(
            (f) => f.lat >= s && f.lat <= n && f.lon >= w && f.lon <= e,
          );
          setCachedTile(tileKeyToString(t), tileFeatures, [...POI_CATEGORIES]);
        }
      } else {
        // Fetch tiles individually (rare — only if viewport spans many tiles)
        for (const t of missingTiles) {
          if (controller.signal.aborted) break;
          const [s, w, n, e] = tileToBbox(t);
          const features = await fetchPoisInBbox(s, w, n, e, cats, controller.signal);
          setCachedTile(tileKeyToString(t), features, [...POI_CATEGORIES]);
        }
      }

      // Collect all features from cache for current viewport
      if (!controller.signal.aborted) {
        const allFeatures = collectFeatures(allKeys, cats);
        updateSourceData(m, allFeatures);
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

      // Initial fetch
      fetchVisiblePois(map);

      // Listen for map movements
      const onMoveEnd = () => debouncedFetch(map);
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

  // ── Re-fetch when enabled categories change ───────────────────────

  useEffect(() => {
    if (!map || !isMapLoaded || !iconsReady.current) return;
    fetchVisiblePois(map);
  }, [map, isMapLoaded, enabledCategories, fetchVisiblePois]);

  return { loading, error, poiCount };
}

// ── Helpers ───────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
