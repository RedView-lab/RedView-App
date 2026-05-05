import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { PlaceSearchInput } from '@/features/itineraryPanel/sections/timeline/components';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';
import './dashboard-place-search.css';

interface DashboardPlaceSearchProps {
  map: MapboxMap | null;
  visible: boolean;
  left: number;
  top: number;
}

const SEARCH_PRELOAD_LEAD_MS = 140;
const SEARCH_NEAR_ZOOM = 14.4;
const SEARCH_MEDIUM_ZOOM = 13.4;
const SEARCH_FAR_ZOOM = 12.35;
const SEARCH_NEAR_MAX_KM = 45;
const SEARCH_MEDIUM_MAX_KM = 180;
const SEARCH_COUNTRIES = 'fr,ch,be,lu,it,de,es,ad';

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

function getSearchCameraProfile(map: MapboxMap, suggestion: GeocodeSuggestion) {
  const currentCenter = map.getCenter();
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

  return {
    targetZoom,
    duration,
    screenSpeed: jumpDistanceKm <= SEARCH_NEAR_MAX_KM ? 1.15 : 0.95,
    curve: jumpDistanceKm <= SEARCH_NEAR_MAX_KM ? 1.2 : 1.42,
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
  visible,
  left,
  top,
}: DashboardPlaceSearchProps) {
  const [proximity, setProximity] = useState<{ lon: number; lat: number } | undefined>(
    undefined,
  );
  const flightTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (flightTimerRef.current !== null) {
      window.clearTimeout(flightTimerRef.current);
      flightTimerRef.current = null;
    }
  }, []);

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

      if (flightTimerRef.current !== null) {
        window.clearTimeout(flightTimerRef.current);
        flightTimerRef.current = null;
      }

      const { targetZoom, duration, screenSpeed, curve } = getSearchCameraProfile(map, suggestion);
      const center: [number, number] = [suggestion.lon, suggestion.lat];
      const camera = {
        center,
        zoom: targetZoom,
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };

      map.stop();
      map.jumpTo({
        ...camera,
        preloadOnly: true,
      });

      flightTimerRef.current = window.setTimeout(() => {
        flightTimerRef.current = null;
        map.flyTo({
          ...camera,
          duration,
          curve,
          screenSpeed,
          maxDuration: 2200,
          essential: true,
        });
      }, SEARCH_PRELOAD_LEAD_MS);
    },
    [map],
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