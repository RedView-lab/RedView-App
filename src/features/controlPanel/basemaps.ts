import type { Basemap, BasemapId } from './types';

interface BasemapOption {
  id: BasemapId;
  label: string;
  styleUrl: string;
}

// Stick to Mapbox-owned public style URLs so the app only pays for the same
// GL JS map usage it already has, without introducing custom Styles API churn.
export const MAPBOX_BASEMAPS: readonly BasemapOption[] = [
  {
    id: 'satellite',
    label: 'Satellite',
    styleUrl: 'mapbox://styles/mapbox/standard-satellite',
  },
  {
    id: 'streets',
    label: 'Streets',
    styleUrl: 'mapbox://styles/mapbox/streets-v12',
  },
  {
    id: 'topographic',
    label: 'Topographique',
    styleUrl: 'mapbox://styles/mapbox/outdoors-v12',
  },
  {
    id: 'standard',
    label: 'Standard / 3D',
    styleUrl: 'mapbox://styles/mapbox/standard',
  },
  {
    id: 'light',
    label: 'Light',
    styleUrl: 'mapbox://styles/mapbox/light-v11',
  },
  {
    id: 'dark',
    label: 'Dark',
    styleUrl: 'mapbox://styles/mapbox/dark-v11',
  },
] as const;

export const DEFAULT_BASEMAP_ID: BasemapId = 'topographic';

const LEGACY_BASEMAP_ALIASES: Record<string, BasemapId> = {
  osm: 'streets',
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
  const resolvedId = normalizeBasemapId(id);
  return MAPBOX_BASEMAPS.find((basemap) => basemap.id === resolvedId)?.styleUrl
    ?? MAPBOX_BASEMAPS[0].styleUrl;
}