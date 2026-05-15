import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import type { BasemapRenderConfig } from '@/features/controlPanel';
import { PlaceSearchInput } from '@/features/itineraryPanel/sections/timeline/components';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';
import { getViewportPrefetch } from '@/features/map3d/lib/viewportPrefetch';
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
  return (
    <svg
      className="rvd-place-search__icon-svg"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7 2.25a4.75 4.75 0 1 0 2.982 8.45l2.659 2.658a.75.75 0 0 0 1.06-1.06l-2.658-2.659A4.75 4.75 0 0 0 7 2.25Zm-3.25 4.75a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function DashboardPlaceSearch({
  map,
  basemapConfig,
  visible,
  left,
  top,
}: DashboardPlaceSearchProps) {
  const [proximity, setProximity] = useState<{ lon: number; lat: number } | undefined>(
    undefined,
  );
  const flightTimerRef = useRef<number | null>(null);
  const settleTokenRef = useRef(0);
  const pendingMoveEndRef = useRef<(() => void) | null>(null);

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
    if (!map) {
      setProximity(undefined);
      return;
    }

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
    pointerEvents: visible ? 'auto' : 'none',
  };

  return (
    <div className="rvd-place-search" style={wrapperStyle} aria-hidden={!visible}>
      <div className="rvd-place-search__shell">
        <MapCanvasGlassBackdrop blur={30} saturate={1.8} tint="rgba(15, 15, 15, 0.74)" />
        <span className="rvd-place-search__icon">
          <SearchIcon />
        </span>
        <PlaceSearchInput
          value=""
          placeholder="Find..."
          proximity={proximity}
          countries={SEARCH_COUNTRIES}
          debounceMs={220}
          className="rvd-place-search__field"
          onPick={handlePick}
        />
      </div>
    </div>
  );
}
