import type { Basemap, BasemapId } from '../types';

export type BasemapVisualFamily = 'mapbox-standard-v3' | 'mapbox-classic-v12';
export type BasemapTerrainContract = 'unified-dem-v1';
export type BasemapLightPreset = 'dawn' | 'day' | 'dusk' | 'night';

export interface BasemapRenderConfig {
  id: BasemapId;
  label: string;
  styleUrl: string;
  visualFamily: BasemapVisualFamily;
  terrainContract: BasemapTerrainContract;
  lightPreset?: BasemapLightPreset;
}

interface BasemapOption extends BasemapRenderConfig {}

// Stick to Mapbox-owned public style URLs so the app only pays for the same
// GL JS map usage it already has, without introducing custom Styles API churn.
export const MAPBOX_BASEMAPS: readonly BasemapOption[] = [
  {
    id: 'standard',
    label: 'Standard (clair)',
    styleUrl: 'mapbox://styles/mapbox/light-v11',
    visualFamily: 'mapbox-classic-v12',
    terrainContract: 'unified-dem-v1',
  },
  {
    id: 'dark',
    label: 'Standard (sombre)',
    styleUrl: 'mapbox://styles/mapbox/dark-v11',
    visualFamily: 'mapbox-classic-v12',
    terrainContract: 'unified-dem-v1',
  },
  {
    id: 'topographic',
    label: 'Topographique',
    styleUrl: 'mapbox://styles/mapbox/outdoors-v12',
    visualFamily: 'mapbox-classic-v12',
    terrainContract: 'unified-dem-v1',
  },
  {
    id: 'satellite',
    label: 'Satellite',
    styleUrl: 'mapbox://styles/mapbox/satellite-streets-v12',
    visualFamily: 'mapbox-classic-v12',
    terrainContract: 'unified-dem-v1',
  },
] as const;

export const DEFAULT_BASEMAP_ID: BasemapId = 'standard';

const LEGACY_BASEMAP_ALIASES: Record<string, BasemapId> = {
  light: 'standard',
  streets: 'standard',
  osm: 'standard',
};

export function normalizeBasemapId(id: BasemapId | null | undefined): BasemapId {
  const candidate = id ? (LEGACY_BASEMAP_ALIASES[id] ?? id) : DEFAULT_BASEMAP_ID;
  return MAPBOX_BASEMAPS.some((basemap) => basemap.id === candidate)
    ? candidate
    : DEFAULT_BASEMAP_ID;
}

export function buildBasemapList(activeId: BasemapId | null | undefined): Basemap[] {
  const resolvedId = normalizeBasemapId(activeId);
  return MAPBOX_BASEMAPS.map((basemap) => {
    const isActive = basemap.id === resolvedId;
    return {
      id: basemap.id,
      label: basemap.label,
      visible: isActive,
      active: isActive,
    };
  });
}

export function getBasemapStyleUrl(id: BasemapId | null | undefined): string {
  return getBasemapConfig(id).styleUrl;
}

export function getBasemapConfig(id: BasemapId | null | undefined): BasemapRenderConfig {
  const resolvedId = normalizeBasemapId(id);
  return MAPBOX_BASEMAPS.find((basemap) => basemap.id === resolvedId)
    ?? MAPBOX_BASEMAPS[0];
}