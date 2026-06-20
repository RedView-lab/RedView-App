import type { Map as MapboxMap, Marker } from 'mapbox-gl';

import type { BasemapRenderConfig } from '@/features/controlPanel';
import type { PoiFeature } from '@/features/poi/types';

export interface DashboardPlaceSearchProps {
  map: MapboxMap | null;
  basemapConfig: BasemapRenderConfig;
  visible: boolean;
  left: number;
  top: number;
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
  | 'bicycle';

export type DashboardFilterId =
  | 'pois_map'
  | 'pois_route'
  | 'favoris'
  | 'pauses'
  | 'waypoints';

export interface DashboardFilterOption {
  id: DashboardFilterId;
  label: string;
  icon: string;
  hasDropdown?: boolean;
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

export interface ViewportPoiLodProfile {
  fetchLimit: number;
}