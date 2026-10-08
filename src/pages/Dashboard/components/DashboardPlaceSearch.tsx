import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import mapboxgl, { type Map as MapboxMap } from 'mapbox-gl';
import type { PoiCategory, PoiFeature } from '@/features/poi/types';
import { PlaceSearchInput } from '@/features/itineraryPanel/sections/timeline/components';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';
import { dispatchItineraryMapAction } from '@/features/itineraryPanel/lib/mapActionBridge';
import { useProjectStoreOptional } from '@/features/itineraryPanel/context/ProjectStore';
import { createDefaultAnalysisPanelState } from '@/features/itineraryPanel/lib/project/defaultState';
import {
  buildPopupContent,
  resolvePopupState,
  type PoiPopupState,
  type UsePoiPopupActions,
} from '@/features/poi/lib/poi-popup';
import { getViewportPrefetch } from '@/features/map3d/lib/viewportPrefetch';
import { closeMarkerPopupOnSecondClick } from '@/features/map3d/lib/pointPanelDismiss';
import { keepPopupInVisibleMap } from '@/features/map3d/lib/mapPopupSafeArea';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import { useAppI18n } from '@/shared/i18n';

import { getSearchCameraProfile } from './DashboardPlaceSearch.camera';
import {
  DASHBOARD_FILTER_OPTIONS,
  DASHBOARD_POI_OPTIONS,
  DASHBOARD_POI_SOURCE_OPTIONS,
  PLACE_SEARCH_ICONS_WIDTH,
  PLACE_SEARCH_TIGHT_WIDTH,
  POI_MENU_CLOSE_MS,
  SEARCH_COUNTRIES,
  VIEWPORT_POI_FETCH_DEBOUNCE_MS,
  VIEWPORT_POI_MIN_ZOOM,
} from './DashboardPlaceSearch.constants';
import { IMMERSIVE_EASING, IMMERSIVE_TRANSITION_MS, PANEL_PADDING } from '../lib/constants';
import {
  FilterCheckbox,
  FilterChipIcon,
  PoiOptionMarker,
  SearchIcon,
  SlopeSwatchIcon,
} from './DashboardPlaceSearch.icons';
import type {
  DashboardFilterChipId,
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
  getViewportPoiMarkerSizePx,
  selectViewportLodPois,
} from './DashboardPlaceSearch.viewport-poi';

import './dashboard-place-search.css';

export function DashboardPlaceSearch({
  map,
  basemapConfig,
  visible,
  left,
  top,
  right,
  maxWidth,
  isResizing = false,
  activeFilters: controlledActiveFilters,
  onFilterChange,
  selectedPoiCategories: controlledSelectedPoiCategories,
  onSelectedPoiCategoriesChange,
  isLeftPanelCollapsed,
  onRestoreLeftPanel,
  onCollapseLeftPanel,
}: DashboardPlaceSearchProps) {
  const { t } = useAppI18n();
  const projectStore = useProjectStoreOptional();
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
  const [openDropdownFilterId, setOpenDropdownFilterId] = useState<DashboardFilterChipId | null>(null);
  const [dropdownMounted, setDropdownMounted] = useState(false);
  const [internalSelectedPoiIds, setInternalSelectedPoiIds] = useState<Set<DashboardPoiOptionId>>(
    () => new Set(DASHBOARD_POI_OPTIONS.map((opt) => opt.id)),
  );
  const selectedPoiIds = controlledSelectedPoiCategories ?? internalSelectedPoiIds;
  const isAllCategoriesSelected = selectedPoiIds.size === DASHBOARD_POI_OPTIONS.length;

  const [internalActiveFilters, setInternalActiveFilters] = useState<Set<DashboardFilterId>>(
    () => new Set<DashboardFilterId>(['pois_route', 'favoris', 'pauses']),
  );
  const activeFilters = controlledActiveFilters ?? internalActiveFilters;

  const handleCloseDropdown = useCallback(() => {
    setOpenDropdownFilterId(null);
  }, []);

  const handleToggleDropdown = useCallback((filterId: DashboardFilterChipId) => {
    setDropdownMounted(true);
    setOpenDropdownFilterId((current) => (current === filterId ? null : filterId));
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
    if (openDropdownFilterId !== null || !dropdownMounted) return;
    const timeoutId = window.setTimeout(() => {
      setDropdownMounted(false);
    }, POI_MENU_CLOSE_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [dropdownMounted, openDropdownFilterId]);

  useEffect(() => {
    if (openDropdownFilterId === null) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      handleCloseDropdown();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleCloseDropdown();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleCloseDropdown, openDropdownFilterId]);

  const lastAppliedPoiSizePxRef = useRef<number>(-1);

  const viewportPoiPopupActions: UsePoiPopupActions = useMemo(() => ({
    onStartHere: (feature) => {
      dispatchItineraryMapAction({ kind: 'poi-action', action: 'start-here', feature });
    },
    onAddWaypoint: (feature) => {
      dispatchItineraryMapAction({ kind: 'poi-action', action: 'add-waypoint', feature });
    },
    onFinishHere: (feature) => {
      dispatchItineraryMapAction({ kind: 'poi-action', action: 'finish-here', feature });
    },
    onToggleFavorite: (feature, nextEnabled, durationMin) => {
      dispatchItineraryMapAction({
        kind: 'poi-action',
        action: 'toggle-favorite',
        feature,
        extra: { nextEnabled, durationMin },
      });
    },
    onTogglePause: (feature, nextEnabled, durationMin) => {
      dispatchItineraryMapAction({
        kind: 'poi-action',
        action: 'toggle-pause',
        feature,
        extra: { nextEnabled, durationMin },
      });
    },
    onSelectPauseDuration: (feature, durationMin) => {
      dispatchItineraryMapAction({
        kind: 'poi-action',
        action: 'set-pause-duration',
        feature,
        extra: { durationMin },
      });
    },
    onCyclePauseDuration: (feature) => {
      dispatchItineraryMapAction({ kind: 'poi-action', action: 'cycle-pause-duration', feature });
    },
    onDelete: (feature) => {
      dispatchItineraryMapAction({ kind: 'poi-action', action: 'delete', feature });
    },
    onOpenStreetView: (feature) => {
      if (typeof window === 'undefined') return;
      const url = new URL('https://www.google.com/maps/@');
      url.searchParams.set('api', '1');
      url.searchParams.set('map_action', 'pano');
      url.searchParams.set('viewpoint', `${feature.lat},${feature.lon}`);
      window.open(url.toString(), '_blank', 'noopener,noreferrer');
    },
  }), []);

  const clearViewportPoiMarkers = useCallback(() => {
    for (const { marker } of poiMarkerRegistryRef.current.values()) {
      marker.remove();
    }
    poiMarkerRegistryRef.current.clear();
    lastAppliedPoiSizePxRef.current = -1;
  }, []);

  const syncViewportPoiMarkerVisualState = useCallback((force = false) => {
    if (!map) return;
    const zoom = map.getZoom();
    const sizePx = getViewportPoiMarkerSizePx(zoom);
    if (!force && lastAppliedPoiSizePxRef.current === sizePx) return;
    lastAppliedPoiSizePxRef.current = sizePx;
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

    const currentZoom = map.getZoom();
    const currentSizePx = getViewportPoiMarkerSizePx(currentZoom);
    lastAppliedPoiSizePxRef.current = currentSizePx;

    for (const feature of features) {
      const key = getViewportPoiMarkerKey(feature);
      const signature = getViewportPoiMarkerSignature(feature);
      const existing = registry.get(key);
      if (existing && existing.signature === signature) continue;

      existing?.marker.remove();

      const popup = new mapboxgl.Popup({
        className: 'rv-poi-popup',
        closeButton: false,
        closeOnClick: true,
        focusAfterOpen: false,
        maxWidth: 'none',
        offset: 24,
      });

      const refresh = (nextState?: PoiPopupState) => {
        popup.setDOMContent(
          buildPopupContent(
            feature,
            resolvePopupState(viewportPoiPopupActions, feature, nextState),
            viewportPoiPopupActions,
            refresh,
          ),
        );
      };

      refresh();
      popup.on('open', () => refresh());
      keepPopupInVisibleMap(popup, map);

      const markerElement = createViewportPoiMarkerElement(feature);
      closeMarkerPopupOnSecondClick(markerElement, popup);
      const marker = new mapboxgl.Marker({
        element: markerElement,
        anchor: feature.favorite ? 'bottom' : 'center',
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
        occludedOpacity: 0,
      })
        .setLngLat([feature.lon, feature.lat])
        .setPopup(popup)
        .addTo(map);

      applyViewportPoiMarkerVisualState(marker, currentZoom);
      registry.set(key, {
        marker,
        signature,
        feature,
      });
    }
  }, [map, viewportPoiPopupActions]);

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

    // Les marqueurs créés avant la fin du chargement des tuiles DEM ont été
    // projetés avec une altitude par défaut (niveau de la mer) ; reposer leur
    // LngLat force une nouvelle projection qui rééchantillonne l'altitude du
    // terrain 3D chargé et évite la dérive de parallaxe.
    const reanchorOnIdle = () => {
      for (const { marker } of poiMarkerRegistryRef.current.values()) {
        marker.setLngLat(marker.getLngLat());
      }
    };
    map.on('idle', reanchorOnIdle);

    return () => {
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
      map.off('zoom', scheduleVisualRefresh);
      map.off('idle', reanchorOnIdle);
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
      if (!activeFilters.has('pois_map') || categories.length === 0 || map.getZoom() < VIEWPORT_POI_MIN_ZOOM) {
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
  }, [activeFilters, clearViewportPoiMarkers, map, selectedPoiIds, syncViewportPoiMarkers]);

  const handlePick = useCallback(
    (suggestion: GeocodeSuggestion) => {
      if (!map) return;
      trackAnalyticsEvent({ name: 'place_selected' });

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
        /* le préchauffage est au mieux — ne bloque jamais la téléportation de recherche */
      }

      try {
        map.flyTo({
          ...finalCamera,
          duration: 0,
          essential: true,
          preloadOnly: true,
        });
      } catch {
        /* preloadOnly est au mieux */
      }
      map.jumpTo(finalCamera);
    },
    [basemapConfig, clearPendingSearchTransition, map],
  );

  const transitionProp = isResizing
    ? 'none'
    : `left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, right ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, max-width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`;

  const wrapperStyle: CSSProperties = {
    position: 'absolute',
    top,
    left,
    right,
    maxWidth: maxWidth != null ? maxWidth : right != null ? undefined : 'calc(100vw - 24px)',
    zIndex: 30,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: PANEL_PADDING,
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(-6px)',
    pointerEvents: visible ? 'auto' : 'none',
    transition: transitionProp,
    willChange: isResizing ? 'auto' : 'left, right, max-width',
  };

  const handleTogglePoiOption = useCallback(
    (optionId: DashboardPoiOptionId) => {
      const next = new Set(selectedPoiIds);
      if (next.has(optionId)) {
        next.delete(optionId);
      } else {
        next.add(optionId);
      }
      if (onSelectedPoiCategoriesChange) {
        onSelectedPoiCategoriesChange(next);
      } else {
        setInternalSelectedPoiIds(next);
      }
    },
    [onSelectedPoiCategoriesChange, selectedPoiIds],
  );

  const handleToggleAllCategories = useCallback(() => {
    const isAll = selectedPoiIds.size === DASHBOARD_POI_OPTIONS.length;
    const next = isAll
      ? new Set<DashboardPoiOptionId>()
      : new Set<DashboardPoiOptionId>(DASHBOARD_POI_OPTIONS.map((o) => o.id));
    if (onSelectedPoiCategoriesChange) {
      onSelectedPoiCategoriesChange(next);
    } else {
      setInternalSelectedPoiIds(next);
    }
  }, [onSelectedPoiCategoriesChange, selectedPoiIds]);

  /** Allume ou éteint des filtres ; une source POI allumée sans catégorie les reprend toutes. */
  const setFiltersEnabled = useCallback(
    (filterIds: readonly DashboardFilterId[], enabled: boolean) => {
      const next = new Set(activeFilters);
      for (const filterId of filterIds) {
        if (enabled) next.add(filterId);
        else next.delete(filterId);
      }
      if (enabled && selectedPoiIds.size === 0 && filterIds.some((id) => id === 'pois_map' || id === 'pois_route')) {
        const allCategories = new Set(DASHBOARD_POI_OPTIONS.map((option) => option.id));
        if (onSelectedPoiCategoriesChange) {
          onSelectedPoiCategoriesChange(allCategories);
        } else {
          setInternalSelectedPoiIds(allCategories);
        }
      }
      if (onFilterChange) {
        onFilterChange(next);
      } else {
        setInternalActiveFilters(next);
      }
    },
    [activeFilters, onFilterChange, onSelectedPoiCategoriesChange, selectedPoiIds],
  );

  // « Alertes » et « Pente » : filtres d'analyse du projet (vue de l'utilisateur),
  // partagés avec le graphique et le tracé de la carte.
  const setProject = projectStore?.setProject;
  const analysisFilters = {
    ...createDefaultAnalysisPanelState().filters,
    ...projectStore?.project.analysis?.filters,
  };
  const toggleAnalysisFilter = useCallback(
    (key: 'alertes' | 'slopeColors') => {
      setProject?.((prev) => {
        const fallback = createDefaultAnalysisPanelState();
        const analysis = prev.analysis ?? fallback;
        const filters = { ...fallback.filters, ...analysis.filters };
        return { ...prev, analysis: { ...analysis, filters: { ...filters, [key]: !filters[key] } } };
      });
    },
    [setProject],
  );

  const isChipActive = (chipId: DashboardFilterChipId): boolean => {
    switch (chipId) {
      case 'pois': return activeFilters.has('pois_route') || activeFilters.has('pois_map');
      case 'alertes': return analysisFilters.alertes;
      case 'pente': return analysisFilters.slopeColors;
      default: return activeFilters.has(chipId);
    }
  };

  const handleToggleChip = (chipId: DashboardFilterChipId) => {
    trackAnalyticsEvent({ name: 'map_filter_toggled', data: { filter: chipId } });
    switch (chipId) {
      case 'pois':
        setFiltersEnabled(['pois_route', 'pois_map'], !isChipActive('pois'));
        return;
      case 'alertes':
        toggleAnalysisFilter('alertes');
        return;
      case 'pente':
        toggleAnalysisFilter('slopeColors');
        return;
      default:
        setFiltersEnabled([chipId], !activeFilters.has(chipId));
    }
  };

  const densityClassName =
    typeof maxWidth !== 'number' || maxWidth >= PLACE_SEARCH_TIGHT_WIDTH
      ? ''
      : maxWidth >= PLACE_SEARCH_ICONS_WIDTH
        ? ' rvd-place-search--tight'
        : ' rvd-place-search--tight rvd-place-search--icons';

  return (
    <div
      className={`rvd-place-search${densityClassName}`}
      style={wrapperStyle}
      aria-hidden={!visible}
    >
      {/*
       * Bascule du tiroir de gauche. Elle partage la rangée flex de
       * l'enveloppe de recherche pour que les gouttières panneau / bouton /
       * barre de recherche gardent exactement PANEL_PADDING et ne puissent
       * jamais chevaucher le champ de recherche de lieu.
       */}
      {onCollapseLeftPanel || onRestoreLeftPanel ? (
        <div className="rvd-place-search__panel-toggle">
          <button
            type="button"
            className={`rvmvc-map-tools__button rvmvc-map-tools__button--panel${
              isLeftPanelCollapsed ? ' is-panel-hidden' : ' is-panel-shown'
            }`}
            aria-label={isLeftPanelCollapsed ? t('Afficher le panneau gauche') : t('Masquer le panneau gauche')}
            aria-pressed={!isLeftPanelCollapsed}
            title={isLeftPanelCollapsed ? t('Afficher le panneau gauche') : t('Masquer le panneau gauche')}
            onClick={isLeftPanelCollapsed ? onRestoreLeftPanel : onCollapseLeftPanel}
          >
            <SvgV2Icon name="route.svg" size={18} />
          </button>
        </div>
      ) : null}

      <div className="rvd-place-search__row" ref={rootRef}>
        <div className="rv-glass rvd-place-search__search-shell">
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
            const active = isChipActive(filter.id);
            const isMenuOpen = openDropdownFilterId === filter.id;
            const shellClassName = `rvd-place-search__filter${
              filter.hasDropdown ? ' rvd-place-search__filter--menu' : ''
            }${active ? ' is-active' : ''}${filter.hasDropdown && isMenuOpen ? ' is-open' : ''}`;
            return (
              <div key={filter.id} className={shellClassName}>
                <div className="rv-glass rvd-place-search__filter-shell">
                  <button
                    type="button"
                    className="rvd-place-search__filter-toggle"
                    aria-pressed={active}
                    aria-label={t(filter.label)}
                    title={t(filter.label)}
                    onClick={() => handleToggleChip(filter.id)}
                  >
                    <FilterCheckbox checked={active} />
                    <span className="rvd-place-search__filter-marker">
                      {filter.slopeSwatch ? <SlopeSwatchIcon /> : null}
                      {filter.icon ? <FilterChipIcon name={filter.icon} /> : null}
                    </span>
                    <span className="rvd-place-search__filter-label" title={t(filter.label)}>{t(filter.label)}</span>
                  </button>
                  {filter.hasDropdown ? (
                    <button
                      type="button"
                      className="rvd-place-search__filter-chevron"
                      aria-haspopup="menu"
                      aria-expanded={isMenuOpen}
                      aria-controls={dropdownMounted ? `rvd-poi-menu-${filter.id}` : undefined}
                      aria-label={t('Catégories POI')}
                      onClick={() => handleToggleDropdown(filter.id)}
                    >
                      <SvgV2Icon name="chevron-down.svg" size={15} />
                    </button>
                  ) : null}
                </div>

                {filter.hasDropdown && dropdownMounted && isMenuOpen ? (
                  <div
                    id={`rvd-poi-menu-${filter.id}`}
                    className="rv-dropdown rvd-place-search__poi-menu"
                    role="menu"
                    aria-label={t('Catégories POI')}
                  >
                    {DASHBOARD_POI_SOURCE_OPTIONS.map((source) => {
                      const enabled = activeFilters.has(source.id);
                      return (
                        <button
                          key={source.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={enabled}
                          className="rv-dropdown__item rv-dropdown__item--no-check"
                          onClick={() => setFiltersEnabled([source.id], !enabled)}
                        >
                          <FilterCheckbox checked={enabled} />
                          <span className="rv-dropdown__label">{t(source.label)}</span>
                        </button>
                      );
                    })}
                    <div className="rv-dropdown__divider" />
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={isAllCategoriesSelected}
                      className={`rv-dropdown__item${isAllCategoriesSelected ? ' is-selected' : ''}`}
                      onClick={handleToggleAllCategories}
                    >
                      <span className="rv-dropdown__label">{t('Toutes les catégories')}</span>
                    </button>
                    <div className="rv-dropdown__divider" />
                    {DASHBOARD_POI_OPTIONS.map((option) => {
                      const selected = selectedPoiIds.has(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={selected}
                          className={`rv-dropdown__item${selected ? ' is-selected' : ''}`}
                          onClick={() => handleTogglePoiOption(option.id)}
                        >
                          <span className="rvd-place-search__poi-option-marker">
                            <PoiOptionMarker option={option} />
                          </span>
                          <span className="rv-dropdown__label">{t(option.label)}</span>
                        </button>
                      );
                    })}
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
