import type { Map as MapboxMap, Marker } from 'mapbox-gl';

import type { BasemapRenderConfig } from '@/features/controlPanel';
import type { PoiFeature } from '@/features/poi/types';

export interface DashboardPlaceSearchProps {
  map: MapboxMap | null;
  basemapConfig: BasemapRenderConfig;
  visible: boolean;
  left: number;
  top: number;
  right?: number;
  maxWidth?: number | string;
  isResizing?: boolean;
  activeFilters?: Set<DashboardFilterId>;
  onFilterChange?: (filters: Set<DashboardFilterId>) => void;
  selectedPoiCategories?: Set<DashboardPoiOptionId>;
  onSelectedPoiCategoriesChange?: (categories: Set<DashboardPoiOptionId>) => void;
  /** Left drawer visibility — drives the mirrored toggle rendered before the search field. */
  isLeftPanelCollapsed?: boolean;
  onRestoreLeftPanel?: () => void;
  onCollapseLeftPanel?: () => void;
}

export type DashboardPoiOptionId =
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
  | 'pass'
  | 'bicycle';

/** Filtres d'affichage tenus par le Dashboard (le chip « POI » en regroupe deux). */
export type DashboardFilterId =
  | 'pois_map'
  | 'pois_route'
  | 'favoris'
  | 'pauses';

/** Chips de la barre ; « Alertes » et « Pente » sont les filtres d'analyse du projet. */
export type DashboardFilterChipId = 'favoris' | 'pois' | 'pauses' | 'alertes' | 'pente';

export interface DashboardFilterOption {
  id: DashboardFilterChipId;
  label: string;
  /** Fichier de `/svgv2/icone/`. */
  icon?: string;
  /** Pastille dégradée de l'échelle de pente à la place d'une icône. */
  slopeSwatch?: boolean;
  hasDropdown?: boolean;
}

export interface DashboardPoiSourceOption {
  id: Extract<DashboardFilterId, 'pois_route' | 'pois_map'>;
  label: string;
}

export interface DashboardPoiOption {
  id: DashboardPoiOptionId;
  label: string;
  color: string;
}

export interface SearchCameraProfile {
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

export interface ViewportPoiMarkerEntry {
  marker: Marker;
  signature: string;
  feature: PoiFeature;
}

export interface ViewportPoiCandidate {
  feature: PoiFeature;
  x: number;
  y: number;
  centerDistance: number;
}
