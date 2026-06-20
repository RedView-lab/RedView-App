import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import mapboxgl, { type Map as MapboxMap } from 'mapbox-gl';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import type { PoiCategory, PoiFeature } from '@/features/poi/types';
import { PlaceSearchInput } from '@/features/itineraryPanel/sections/timeline/components';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';
import { getViewportPrefetch } from '@/features/map3d/lib/viewportPrefetch';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import { getSearchCameraProfile } from './DashboardPlaceSearch.camera';
import {
  DASHBOARD_FILTER_OPTIONS,
  DASHBOARD_POI_OPTIONS,
  POI_MENU_CLOSE_MS,
  SEARCH_COUNTRIES,
  VIEWPORT_POI_FETCH_DEBOUNCE_MS,
  VIEWPORT_POI_MIN_ZOOM,
} from './DashboardPlaceSearch.constants';
import {
  FilterChipIcon,
  PoiOptionMarker,
  SearchIcon,
} from './DashboardPlaceSearch.icons';
import type {
  DashboardFilterId,
  DashboardPlaceSearchProps,
  DashboardPoiOptionId,
  ViewportPoiMarkerEntry,
} from './DashboardPlaceSearch.types';
import {
  applyViewportPoiMarkerVisualState,
  createViewportPoiMarkerElement,
  fetchVisibleViewportPois,
  getViewportPoiMarkerKey,
  getViewportPoiMarkerSignature,
  selectViewportLodPois,
} from './DashboardPlaceSearch.viewport-poi';

import './dashboard-place-search.css';

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
  const [activeFilters, setActiveFilters] = useState<Set<DashboardFilterId>>(
    () => new Set<DashboardFilterId>(['pois_route', 'favoris', 'pauses']),
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

  const syncViewportPoiMarkerVisualState = useCallback(() => {
    if (!map) return;
    const zoom = map.getZoom();
    for (const { marker } of poiMarkerRegistryRef.current.values()) {
      applyViewportPoiMarkerVisualState(marker, zoom);
    }
  }, [map]);

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
      const marker = new mapboxgl.Marker({
          element: createViewportPoiMarkerElement(feature),
          anchor: 'center',
          pitchAlignment: 'viewport',
          rotationAlignment: 'viewport',
          occludedOpacity: 0.85,
        }).setLngLat([feature.lon, feature.lat]).addTo(map);
      applyViewportPoiMarkerVisualState(marker, map.getZoom());
      registry.set(key, {
        marker,
        signature,
        feature,
      });
    }
  }, [map]);

  useEffect(() => {
    if (!map) return;

    let frameId: number | null = null;
    const scheduleVisualRefresh = () => {
      if (frameId != null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncViewportPoiMarkerVisualState();
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
  }, [map, syncViewportPoiMarkerVisualState]);

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
      const retainedFeatures = [...poiMarkerRegistryRef.current.values()]
        .map((entry) => entry.feature)
        .filter((feature) => categories.includes(feature.category));
      const stickyKeys = new Set(retainedFeatures.map(getViewportPoiMarkerKey));

      void fetchVisibleViewportPois(map, categories, controller.signal)
        .then((features) => {
          if (controller.signal.aborted) return;
          const mergedFeatures = new Map<string, PoiFeature>();
          for (const feature of retainedFeatures) {
            mergedFeatures.set(getViewportPoiMarkerKey(feature), feature);
          }
          for (const feature of features) {
            mergedFeatures.set(getViewportPoiMarkerKey(feature), feature);
          }
          syncViewportPoiMarkers(
            selectViewportLodPois(map, [...mergedFeatures.values()], categories, stickyKeys),
          );
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
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

  const handleToggleFilter = useCallback((filterId: DashboardFilterId) => {
    if (filterId === 'pois_map') {
      setSelectedPoiIds((current) => {
        if (current.size > 0) return new Set();
        return new Set(DASHBOARD_POI_OPTIONS.map((option) => option.id));
      });
      return;
    }
    setActiveFilters((current) => {
      const next = new Set(current);
      if (next.has(filterId)) {
        next.delete(filterId);
      } else {
        next.add(filterId);
      }
      return next;
    });
  }, []);

  const isFilterActive = useCallback(
    (filterId: DashboardFilterId) =>
      filterId === 'pois_map' ? selectedPoiIds.size > 0 : activeFilters.has(filterId),
    [activeFilters, selectedPoiIds],
  );

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

        <div className="rvd-place-search__filters">
          {DASHBOARD_FILTER_OPTIONS.map((filter) => {
            const active = isFilterActive(filter.id);
            const shellClassName = `rvd-place-search__filter${
              active ? ' is-active' : ''
            }${filter.hasDropdown && poiMenuOpen ? ' is-open' : ''}`;
            return (
              <div key={filter.id} className={shellClassName}>
                <div className="rvd-place-search__filter-shell">
                  <MapCanvasGlassBackdrop
                    blur={60}
                    saturate={1.8}
                    tint={active ? 'rgba(15, 15, 15, 0.74)' : 'rgba(52, 52, 52, 0.77)'}
                  />
                  <button
                    type="button"
                    className="rvd-place-search__filter-toggle"
                    aria-pressed={active}
                    aria-label={t(filter.label)}
                    onClick={() => handleToggleFilter(filter.id)}
                  >
                    <span
                      className={`rvd-place-search__filter-checkbox${
                        active ? ' is-checked' : ''
                      }`}
                      aria-hidden="true"
                    >
                      {active ? <SvgV2Icon name="check.svg" size={12} /> : null}
                    </span>
                    <span className="rvd-place-search__filter-marker">
                      <FilterChipIcon name={filter.icon} />
                    </span>
                    <span className="rvd-place-search__filter-label">{t(filter.label)}</span>
                  </button>
                  {filter.hasDropdown ? (
                    <button
                      type="button"
                      className="rvd-place-search__filter-chevron"
                      aria-haspopup="menu"
                      aria-expanded={poiMenuOpen}
                      aria-controls={poiMenuMounted ? 'rvd-poi-menu' : undefined}
                      aria-label={t('Catégories POI')}
                      onClick={handleTogglePoiMenu}
                    >
                      <SvgV2Icon name="chevron-down.svg" size={14} />
                    </button>
                  ) : null}
                </div>

                {filter.hasDropdown && poiMenuMounted ? (
                  <div
                    id="rvd-poi-menu"
                    className={`rvd-place-search__poi-menu${
                      poiMenuOpen ? ' is-open' : ' is-closing'
                    }`}
                    role="menu"
                    aria-label={t('Catégories POI')}
                  >
                    <MapCanvasGlassBackdrop
                      blur={60}
                      saturate={1.8}
                      tint="rgba(15, 15, 15, 0.74)"
                    />
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
                            <span className="rvd-place-search__poi-option-label">
                              {t(option.label)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
