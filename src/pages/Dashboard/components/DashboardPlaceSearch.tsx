import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import mapboxgl, { type Map as MapboxMap } from 'mapbox-gl';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import type { BasemapRenderConfig } from '@/features/controlPanel';
import { fetchPoisInBbox } from '@/features/poi/lib/poi-api';
import { getPoiIconUrl } from '@/features/poi/lib/poi-icons';
import type { PoiCategory, PoiFeature } from '@/features/poi/types';
import { PlaceSearchInput } from '@/features/itineraryPanel/sections/timeline/components';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';
import { getViewportPrefetch } from '@/features/map3d/lib/viewportPrefetch';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';
import './dashboard-place-search.css';

interface DashboardPlaceSearchProps {
  map: MapboxMap | null;
  basemapConfig: BasemapRenderConfig;
  visible: boolean;
  left: number;
  top: number;
}

const SEARCH_PRELOAD_LEAD_MS = 140;
const SEARCH_SATELLITE_PRELOAD_LEAD_MS = 240;
const SEARCH_NEAR_ZOOM = 14.4;
const SEARCH_MEDIUM_ZOOM = 13.4;
const SEARCH_FAR_ZOOM = 12.35;
const SEARCH_NEAR_MAX_KM = 45;
const SEARCH_MEDIUM_MAX_KM = 180;
const SEARCH_COUNTRIES = 'fr,ch,be,lu,it,de,es,ad';
const SEARCH_SATELLITE_STAGE_MIN_KM = 16;
const SEARCH_SATELLITE_NEAR_ENTRY_PITCH = 46;
const SEARCH_SATELLITE_MEDIUM_ENTRY_PITCH = 34;
const SEARCH_SATELLITE_FAR_ENTRY_PITCH = 26;
const SEARCH_SATELLITE_NEAR_ZOOM_DELTA = 0.35;
const SEARCH_SATELLITE_MEDIUM_ZOOM_DELTA = 0.7;
const SEARCH_SATELLITE_FAR_ZOOM_DELTA = 0.95;
const SEARCH_SATELLITE_NEAR_SETTLE_MS = 700;
const SEARCH_SATELLITE_MEDIUM_SETTLE_MS = 1100;
const SEARCH_SATELLITE_FAR_SETTLE_MS = 1500;
const SEARCH_SATELLITE_NEAR_RESTORE_MS = 550;
const SEARCH_SATELLITE_MEDIUM_RESTORE_MS = 700;
const SEARCH_SATELLITE_FAR_RESTORE_MS = 900;
const VIEWPORT_POI_MIN_ZOOM = 10.8;
const VIEWPORT_POI_FETCH_DEBOUNCE_MS = 120;

type DashboardPoiOptionId =
  | 'drinking_water'
  | 'toilets'
  | 'supermarket'
  | 'bakery'
  | 'fuel'
  | 'bar'
  | 'cafe'
  | 'restaurant'
  | 'convenience'
  | 'hotel'
  | 'alpine_hut'
  | 'bicycle';

interface DashboardPoiOption {
  id: DashboardPoiOptionId;
  label: string;
  color: string;
}

const DASHBOARD_POI_OPTIONS: readonly DashboardPoiOption[] = [
  { id: 'drinking_water', label: 'Eau', color: '#1447E6' },
  { id: 'toilets', label: 'Toilette', color: '#312C85' },
  { id: 'supermarket', label: 'Supermarché', color: '#F1B100' },
  { id: 'bakery', label: 'Boulangerie', color: '#FF6900' },
  { id: 'fuel', label: 'Station Service', color: '#CA3500' },
  { id: 'bar', label: 'Bar', color: '#C70036' },
  { id: 'cafe', label: 'Café', color: '#FF2157' },
  { id: 'restaurant', label: 'Restaurant', color: '#8B0836' },
  { id: 'convenience', label: 'Supermarché', color: '#A900B7' },
  { id: 'hotel', label: 'Hôtel', color: '#008236' },
  { id: 'alpine_hut', label: 'Refuge', color: '#7DCF00' },
  { id: 'bicycle', label: 'Magasin de vélo', color: '#63758E' },
] as const;

const POI_MENU_CLOSE_MS = 150;

interface SearchCameraProfile {
  targetZoom: number;
  duration: number;
  screenSpeed: number;
  curve: number;
  preloadLeadMs: number;
  entryZoom: number;
  entryPitch: number;
  finalPitch: number;
  shouldStageFinalApproach: boolean;
  settleWaitMs: number;
  finalApproachDuration: number;
}

interface ViewportPoiMarkerEntry {
  marker: mapboxgl.Marker;
  signature: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function distanceKm(from: { lon: number; lat: number }, to: { lon: number; lat: number }): number {
  const toRad = (value: number) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSearchCameraProfile(
  map: MapboxMap,
  basemapConfig: BasemapRenderConfig,
  suggestion: GeocodeSuggestion,
): SearchCameraProfile {
  const currentCenter = map.getCenter();
  const currentPitch = map.getPitch();
  const jumpDistanceKm = distanceKm(
    { lon: currentCenter.lng, lat: currentCenter.lat },
    { lon: suggestion.lon, lat: suggestion.lat },
  );

  const targetZoom = jumpDistanceKm <= SEARCH_NEAR_MAX_KM
    ? clamp(map.getZoom(), 13.6, SEARCH_NEAR_ZOOM)
    : jumpDistanceKm <= SEARCH_MEDIUM_MAX_KM
      ? clamp(map.getZoom(), 12.8, SEARCH_MEDIUM_ZOOM)
      : clamp(map.getZoom(), 11.6, SEARCH_FAR_ZOOM);

  const duration = jumpDistanceKm <= SEARCH_NEAR_MAX_KM
    ? 1050
    : jumpDistanceKm <= SEARCH_MEDIUM_MAX_KM
      ? 1450
      : 1900;

  const isSatellite = basemapConfig.id === 'satellite';
  const shouldStageFinalApproach = isSatellite && (
    jumpDistanceKm >= SEARCH_SATELLITE_STAGE_MIN_KM
    || currentPitch >= SEARCH_SATELLITE_NEAR_ENTRY_PITCH
  );

  const entryZoom = shouldStageFinalApproach
    ? jumpDistanceKm <= SEARCH_NEAR_MAX_KM
      ? Math.max(13.1, targetZoom - SEARCH_SATELLITE_NEAR_ZOOM_DELTA)
      : jumpDistanceKm <= SEARCH_MEDIUM_MAX_KM
        ? Math.max(12.2, targetZoom - SEARCH_SATELLITE_MEDIUM_ZOOM_DELTA)
        : Math.max(11.1, targetZoom - SEARCH_SATELLITE_FAR_ZOOM_DELTA)
    : targetZoom;

  const entryPitch = shouldStageFinalApproach
    ? jumpDistanceKm <= SEARCH_NEAR_MAX_KM
      ? Math.min(currentPitch, SEARCH_SATELLITE_NEAR_ENTRY_PITCH)
      : jumpDistanceKm <= SEARCH_MEDIUM_MAX_KM
        ? Math.min(currentPitch, SEARCH_SATELLITE_MEDIUM_ENTRY_PITCH)
        : Math.min(currentPitch, SEARCH_SATELLITE_FAR_ENTRY_PITCH)
    : currentPitch;

  const settleWaitMs = shouldStageFinalApproach
    ? jumpDistanceKm <= SEARCH_NEAR_MAX_KM
      ? SEARCH_SATELLITE_NEAR_SETTLE_MS
      : jumpDistanceKm <= SEARCH_MEDIUM_MAX_KM
        ? SEARCH_SATELLITE_MEDIUM_SETTLE_MS
        : SEARCH_SATELLITE_FAR_SETTLE_MS
    : 0;

  const finalApproachDuration = shouldStageFinalApproach
    ? jumpDistanceKm <= SEARCH_NEAR_MAX_KM
      ? SEARCH_SATELLITE_NEAR_RESTORE_MS
      : jumpDistanceKm <= SEARCH_MEDIUM_MAX_KM
        ? SEARCH_SATELLITE_MEDIUM_RESTORE_MS
        : SEARCH_SATELLITE_FAR_RESTORE_MS
    : 0;

  return {
    targetZoom,
    duration,
    screenSpeed: jumpDistanceKm <= SEARCH_NEAR_MAX_KM ? 1.15 : 0.95,
    curve: jumpDistanceKm <= SEARCH_NEAR_MAX_KM ? 1.2 : 1.42,
    preloadLeadMs: shouldStageFinalApproach ? SEARCH_SATELLITE_PRELOAD_LEAD_MS : SEARCH_PRELOAD_LEAD_MS,
    entryZoom,
    entryPitch,
    finalPitch: currentPitch,
    shouldStageFinalApproach,
    settleWaitMs,
    finalApproachDuration,
  };
}

function SearchIcon() {
  return <SvgV2Icon name="search-sm.svg" size={20} />;
}

function PoiOptionMarker({ option }: { option: DashboardPoiOption }) {
  return (
    <img
      className="rvd-place-search__poi-option-marker-image"
      src={getPoiIconUrl(option.id as PoiCategory)}
      alt=""
      draggable="false"
    />
  );
}

function PoiTriggerIcon() {
  return <SvgV2Icon name="poi-pin.svg" size={20} />;
}

function getViewportPoiMarkerKey(feature: PoiFeature): string {
  return `${feature.category}:${feature.id}`;
}

function getViewportPoiMarkerSignature(feature: PoiFeature): string {
  return [feature.category, feature.id, feature.lat, feature.lon].join('|');
}

function getViewportPoiResultLimit(zoom: number): number {
  if (zoom < 11.8) return 300;
  if (zoom < 12.7) return 650;
  if (zoom < 13.7) return 1_100;
  return 1_600;
}

function createViewportPoiMarkerElement(feature: PoiFeature): HTMLDivElement {
  const element = document.createElement('div');
  element.style.display = 'inline-flex';
  element.style.alignItems = 'center';
  element.style.justifyContent = 'center';
  element.style.width = '24px';
  element.style.height = '24px';
  element.style.filter = 'drop-shadow(0 0 6px rgba(0,0,0,0.16))';
  element.style.pointerEvents = 'none';

  const image = document.createElement('img');
  image.src = getPoiIconUrl(feature.category);
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  image.style.display = 'block';
  image.style.width = '24px';
  image.style.height = '24px';

  element.appendChild(image);
  return element;
}

async function fetchVisibleViewportPois(
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
  const limit = getViewportPoiResultLimit(map.getZoom());

  if (west <= east) {
    return fetchPoisInBbox(south, west, north, east, categories, signal, limit);
  }

  const [left, right] = await Promise.all([
    fetchPoisInBbox(south, west, north, 180, categories, signal, limit),
    fetchPoisInBbox(south, -180, north, east, categories, signal, limit),
  ]);
  const deduped = new Map<string, PoiFeature>();
  for (const feature of [...left, ...right]) {
    deduped.set(getViewportPoiMarkerKey(feature), feature);
  }
  return [...deduped.values()];
}

export function DashboardPlaceSearch({
  map,
  basemapConfig,
  visible,
  left,
  top,
}: DashboardPlaceSearchProps) {
  const { t } = useAppI18n();
  const [proximity, setProximity] = useState<{ lon: number; lat: number } | undefined>(
    undefined,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const flightTimerRef = useRef<number | null>(null);
  const settleTokenRef = useRef(0);
  const pendingMoveEndRef = useRef<(() => void) | null>(null);
  const poiFetchTimerRef = useRef<number | null>(null);
  const poiAbortRef = useRef<AbortController | null>(null);
  const poiMarkerRegistryRef = useRef<Map<string, ViewportPoiMarkerEntry>>(new Map());
  const [poiMenuOpen, setPoiMenuOpen] = useState(false);
  const [poiMenuMounted, setPoiMenuMounted] = useState(false);
  const [selectedPoiIds, setSelectedPoiIds] = useState<Set<DashboardPoiOptionId>>(
    () => new Set(),
  );

  const handleClosePoiMenu = useCallback(() => {
    setPoiMenuOpen(false);
  }, []);

  const handleTogglePoiMenu = useCallback(() => {
    setPoiMenuMounted(true);
    setPoiMenuOpen((open) => !open);
  }, []);

  const clearPendingSearchTransition = useCallback((mapInstance: MapboxMap | null) => {
    settleTokenRef.current += 1;
    if (flightTimerRef.current !== null) {
      window.clearTimeout(flightTimerRef.current);
      flightTimerRef.current = null;
    }
    if (mapInstance && pendingMoveEndRef.current) {
      mapInstance.off('moveend', pendingMoveEndRef.current);
      pendingMoveEndRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearPendingSearchTransition(map);
  }, [clearPendingSearchTransition, map]);

  useEffect(() => {
    if (!map) return;

    const syncProximity = () => {
      const center = map.getCenter();
      setProximity({ lon: center.lng, lat: center.lat });
    };

    syncProximity();
    map.on('moveend', syncProximity);

    return () => {
      map.off('moveend', syncProximity);
    };
  }, [map]);

  useEffect(() => {
    if (poiMenuOpen || !poiMenuMounted) return;
    const timeoutId = window.setTimeout(() => {
      setPoiMenuMounted(false);
    }, POI_MENU_CLOSE_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [poiMenuMounted, poiMenuOpen]);

  useEffect(() => {
    if (!poiMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      handleClosePoiMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClosePoiMenu();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleClosePoiMenu, poiMenuOpen]);

  const clearViewportPoiMarkers = useCallback(() => {
    for (const { marker } of poiMarkerRegistryRef.current.values()) {
      marker.remove();
    }
    poiMarkerRegistryRef.current.clear();
  }, []);

  const syncViewportPoiMarkers = useCallback((features: PoiFeature[]) => {
    if (!map) return;

    const registry = poiMarkerRegistryRef.current;
    const nextKeys = new Set(features.map(getViewportPoiMarkerKey));

    for (const [key, entry] of registry) {
      if (nextKeys.has(key)) continue;
      entry.marker.remove();
      registry.delete(key);
    }

    for (const feature of features) {
      const key = getViewportPoiMarkerKey(feature);
      const signature = getViewportPoiMarkerSignature(feature);
      const existing = registry.get(key);
      if (existing && existing.signature === signature) continue;

      existing?.marker.remove();
      registry.set(key, {
        marker: new mapboxgl.Marker({
          element: createViewportPoiMarkerElement(feature),
          anchor: 'center',
          pitchAlignment: 'viewport',
          rotationAlignment: 'viewport',
          occludedOpacity: 0.85,
        }).setLngLat([feature.lon, feature.lat]).addTo(map),
        signature,
      });
    }
  }, [map]);

  useEffect(() => {
    if (!map) return;

    const categories = [...selectedPoiIds] as PoiCategory[];

    const clearScheduledRefresh = () => {
      if (poiFetchTimerRef.current != null) {
        window.clearTimeout(poiFetchTimerRef.current);
        poiFetchTimerRef.current = null;
      }
    };

    const abortInFlightFetch = () => {
      poiAbortRef.current?.abort();
      poiAbortRef.current = null;
    };

    const refreshViewportPois = () => {
      if (categories.length === 0 || map.getZoom() < VIEWPORT_POI_MIN_ZOOM) {
        abortInFlightFetch();
        clearViewportPoiMarkers();
        return;
      }

      abortInFlightFetch();
      const controller = new AbortController();
      poiAbortRef.current = controller;

      void fetchVisibleViewportPois(map, categories, controller.signal)
        .then((features) => {
          if (controller.signal.aborted) return;
          syncViewportPoiMarkers(features);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          clearViewportPoiMarkers();
        });
    };

    const scheduleViewportRefresh = () => {
      clearScheduledRefresh();
      poiFetchTimerRef.current = window.setTimeout(() => {
        poiFetchTimerRef.current = null;
        refreshViewportPois();
      }, VIEWPORT_POI_FETCH_DEBOUNCE_MS);
    };

    scheduleViewportRefresh();
    map.on('moveend', scheduleViewportRefresh);

    return () => {
      map.off('moveend', scheduleViewportRefresh);
      clearScheduledRefresh();
      abortInFlightFetch();
      clearViewportPoiMarkers();
    };
  }, [clearViewportPoiMarkers, map, selectedPoiIds, syncViewportPoiMarkers]);

  const handlePick = useCallback(
    (suggestion: GeocodeSuggestion) => {
      if (!map) return;

      clearPendingSearchTransition(map);

      const { targetZoom, finalPitch } = getSearchCameraProfile(map, basemapConfig, suggestion);
      const center: [number, number] = [suggestion.lon, suggestion.lat];
      const finalCamera = {
        center,
        zoom: targetZoom,
        bearing: map.getBearing(),
        pitch: finalPitch,
      };

      map.stop();

      try {
        getViewportPrefetch()?.prewarmDestination(
          suggestion.lon,
          suggestion.lat,
          targetZoom,
        );
      } catch {
        /* prewarm is best-effort — never block the search teleport */
      }

      try {
        map.flyTo({
          ...finalCamera,
          duration: 0,
          essential: true,
          preloadOnly: true,
        });
      } catch {
        /* preloadOnly is best-effort */
      }
      map.jumpTo(finalCamera);
    },
    [basemapConfig, clearPendingSearchTransition, map],
  );

  const wrapperStyle: CSSProperties = {
    position: 'absolute',
    top,
    left,
    zIndex: 30,
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(-6px)',
    pointerEvents: visible ? 'auto' : 'none',
  };

  const handleTogglePoiOption = useCallback((optionId: DashboardPoiOptionId) => {
    setSelectedPoiIds((current) => {
      const next = new Set(current);
      if (next.has(optionId)) {
        next.delete(optionId);
      } else {
        next.add(optionId);
      }
      return next;
    });
  }, []);

  return (
    <div className="rvd-place-search" style={wrapperStyle} aria-hidden={!visible}>
      <div className="rvd-place-search__row" ref={rootRef}>
        <div className="rvd-place-search__search-shell">
          <MapCanvasGlassBackdrop blur={60} saturate={1.8} tint="rgba(15, 15, 15, 0.74)" />
          <span className="rvd-place-search__icon">
            <SearchIcon />
          </span>
          <PlaceSearchInput
            value=""
            placeholder={t('Rechercher un lieu')}
            proximity={map ? proximity : undefined}
            countries={SEARCH_COUNTRIES}
            debounceMs={220}
            className="rvd-place-search__field"
            onPick={handlePick}
          />
        </div>

        <div className={`rvd-place-search__poi${poiMenuOpen ? ' is-open' : ''}`}>
          <div className="rvd-place-search__poi-trigger-shell">
            <MapCanvasGlassBackdrop blur={60} saturate={1.8} tint="rgba(15, 15, 15, 0.74)" />
            <button
              type="button"
              className="rvd-place-search__poi-trigger"
              aria-haspopup="menu"
              aria-expanded={poiMenuOpen}
              aria-controls={poiMenuMounted ? 'rvd-poi-menu' : undefined}
              aria-label={t('Point d\'intérêt')}
              onClick={handleTogglePoiMenu}
            >
              <span className="rvd-place-search__poi-trigger-marker">
                <PoiTriggerIcon />
              </span>
              <span className="rvd-place-search__poi-trigger-label">{t('Point d\'intérêt')}</span>
              <span className="rvd-place-search__poi-trigger-chevron" aria-hidden="true">
                <SvgV2Icon name="chevron-down.svg" size={14} />
              </span>
            </button>
          </div>

          {poiMenuMounted ? (
            <div
              id="rvd-poi-menu"
              className={`rvd-place-search__poi-menu${poiMenuOpen ? ' is-open' : ' is-closing'}`}
              role="menu"
              aria-label={t('Catégories POI')}
            >
              <MapCanvasGlassBackdrop blur={60} saturate={1.8} tint="rgba(15, 15, 15, 0.74)" />
              <div className="rvd-place-search__poi-menu-list">
                {DASHBOARD_POI_OPTIONS.map((option) => {
                  const selected = selectedPoiIds.has(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={selected}
                      className="rvd-place-search__poi-option"
                      onClick={() => handleTogglePoiOption(option.id)}
                    >
                      <span className="rvd-place-search__poi-checkbox" aria-hidden="true">
                        {selected ? <SvgV2Icon name="check.svg" size={12} /> : null}
                      </span>
                      <span className="rvd-place-search__poi-option-marker">
                        <PoiOptionMarker option={option} />
                      </span>
                      <span className="rvd-place-search__poi-option-label">{t(option.label)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
