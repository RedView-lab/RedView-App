import type { Map as MapboxMap } from 'mapbox-gl';

import type { BasemapRenderConfig } from '@/features/controlPanel';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';

import {
  SEARCH_FAR_ZOOM,
  SEARCH_MEDIUM_MAX_KM,
  SEARCH_MEDIUM_ZOOM,
  SEARCH_NEAR_MAX_KM,
  SEARCH_NEAR_ZOOM,
  SEARCH_PRELOAD_LEAD_MS,
  SEARCH_SATELLITE_FAR_ENTRY_PITCH,
  SEARCH_SATELLITE_FAR_RESTORE_MS,
  SEARCH_SATELLITE_FAR_SETTLE_MS,
  SEARCH_SATELLITE_FAR_ZOOM_DELTA,
  SEARCH_SATELLITE_MEDIUM_ENTRY_PITCH,
  SEARCH_SATELLITE_MEDIUM_RESTORE_MS,
  SEARCH_SATELLITE_MEDIUM_SETTLE_MS,
  SEARCH_SATELLITE_MEDIUM_ZOOM_DELTA,
  SEARCH_SATELLITE_NEAR_ENTRY_PITCH,
  SEARCH_SATELLITE_NEAR_RESTORE_MS,
  SEARCH_SATELLITE_NEAR_SETTLE_MS,
  SEARCH_SATELLITE_NEAR_ZOOM_DELTA,
  SEARCH_SATELLITE_PRELOAD_LEAD_MS,
  SEARCH_SATELLITE_STAGE_MIN_KM,
} from './DashboardPlaceSearch.constants';
import type { SearchCameraProfile } from './DashboardPlaceSearch.types';

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

export function getSearchCameraProfile(
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