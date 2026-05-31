import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import type { BasemapRenderConfig } from '@/features/controlPanel';
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

function PoiPinBadge({
  color,
  children,
}: {
  color: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="rvd-place-search__poi-pin" aria-hidden="true">
      <svg className="rvd-place-search__poi-pin-shape" viewBox="0 0 28 30" focusable="false">
        <path
          d="M8.73245 18.4551C6.0476 15.7703 6.0476 11.4172 8.73245 8.73239C11.4173 6.04754 15.7703 6.04754 18.4552 8.73239C21.14 11.4172 21.14 15.7703 18.4552 18.4551L14.0075 22.9027C13.779 23.1312 13.4086 23.1312 13.1801 22.9027L8.73245 18.4551Z"
          fill={color}
        />
        <path
          d="M8.73245 18.4551C6.0476 15.7703 6.0476 11.4172 8.73245 8.73239C11.4173 6.04754 15.7703 6.04754 18.4552 8.73239C21.14 11.4172 21.14 15.7703 18.4552 18.4551L14.0075 22.9027C13.779 23.1312 13.4086 23.1312 13.1801 22.9027L8.73245 18.4551Z"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="0.9375"
        />
      </svg>
      {children ? <span className="rvd-place-search__poi-pin-glyph">{children}</span> : null}
    </span>
  );
}

function PoiOptionGlyph({ kind }: { kind: DashboardPoiOptionId }) {
  switch (kind) {
    case 'drinking_water':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M7.2 1.55c0 1.08-.72 1.7-1.55 2.5-.88.86-1.7 1.67-1.7 3.03 0 1.33 1 2.37 2.3 2.37 1.33 0 2.35-1.03 2.35-2.37 0-1.07-.64-1.76-1.4-2.55-.52-.55-1-1.09-1-1.98Z" fill="currentColor" />
          <path d="M3.2 3.5c0 .73-.46 1.18-.96 1.67-.52.5-.99.96-.99 1.72 0 .78.57 1.38 1.32 1.38" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'toilets':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <text x="6" y="8.05" textAnchor="middle" fontSize="5.25" fontWeight="700" fill="currentColor">WC</text>
        </svg>
      );
    case 'supermarket':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2 2.5h1.2l.7 3.35h4.36l1-2.55H4.28" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="4.8" cy="8.95" r="0.75" fill="currentColor" />
          <circle cx="8.2" cy="8.95" r="0.75" fill="currentColor" />
        </svg>
      );
    case 'bakery':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2.1 7.45c0-1.6 1.54-2.85 3.9-2.85 2.25 0 3.9 1.1 3.9 2.85 0 1.06-.72 2.05-1.92 2.05H4.03c-1.22 0-1.93-.97-1.93-2.05Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M4.6 5.05c.2.35.15.67-.18.96M6.15 4.8c.2.34.14.66-.18.95M7.7 5.05c.2.35.15.67-.18.96" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
        </svg>
      );
    case 'fuel':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M3.2 2.1h3.2v7.35H3.2Zm3.2 1.15h1.35c.56 0 1 .45 1 1V9.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.15 3.2h1.3" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
        </svg>
      );
    case 'bar':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2.4 2.4h7.2L6.95 5.6v1.7h1.2M5.75 7.3h1.2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'cafe':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2.75 4.2h4v2.35c0 1-.8 1.8-1.8 1.8H4.55c-1 0-1.8-.8-1.8-1.8Z" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinejoin="round" />
          <path d="M6.75 4.75h1.1c.48 0 .87.4.87.88 0 .49-.39.88-.87.88h-.6M3 9h4.7" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'restaurant':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M3.1 2.2v3.15M4.35 2.2v3.15M3.1 3.85h1.25M3.72 5.35v3.95M7.45 2.2v2.55c0 .8.65 1.45 1.45 1.45V10" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'convenience':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2.1 5h7.8M2.55 4.95l.72-1.78h5.46l.72 1.78M3.1 5v2.55c0 .7.58 1.28 1.28 1.28h3.24c.7 0 1.28-.58 1.28-1.28V5" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.7 6.15h2.6" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
        </svg>
      );
    case 'hotel':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2.35 8.9V3.3h2.1v2.05h3.1V3.95h2.1V8.9M1.9 8.9h8.2M3.45 4.35h.01" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'alpine_hut':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <path d="M2.2 5.6 6 2.7l3.8 2.9v3.7H2.2Z" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinejoin="round" />
          <path d="M5.1 9.3V6.95h1.8V9.3" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'bicycle':
      return (
        <svg className="rvd-place-search__poi-glyph" viewBox="0 0 12 12" focusable="false">
          <circle cx="3.15" cy="8.2" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.05" />
          <circle cx="8.85" cy="8.2" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.05" />
          <path d="M4.7 3.05h1.55l1.05 2.15H5.55l1.65 3M4.7 3.05 3.9 5.2m2.35 0h2.35M7.3 5.2l.9-1.45" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }

  return null;
}

function SearchIcon() {
  return <SvgV2Icon name="search-sm.svg" size={20} />;
}

function PoiOptionMarker({ option }: { option: DashboardPoiOption }) {
  return (
    <PoiPinBadge color={option.color}>
      <PoiOptionGlyph kind={option.id} />
    </PoiPinBadge>
  );
}

function PoiTriggerIcon() {
  return <PoiPinBadge color="#000000" />;
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
  const [poiMenuOpen, setPoiMenuOpen] = useState(false);
  const [poiMenuMounted, setPoiMenuMounted] = useState(false);
  const [selectedPoiIds, setSelectedPoiIds] = useState<Set<DashboardPoiOptionId>>(
    () => new Set(DASHBOARD_POI_OPTIONS.map(({ id }) => id)),
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
