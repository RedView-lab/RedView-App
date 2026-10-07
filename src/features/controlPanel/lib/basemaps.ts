import {
  REDVIEW_TOPO_DARK_STYLE_URL,
  REDVIEW_TOPO_LIGHT_STYLE_URL,
} from '@/features/map3d/lib/basemapThemes/urls';
import type { Basemap, BasemapId } from '../types';

type BasemapVisualFamily = 'mapbox-standard-v3' | 'mapbox-classic-v12';
type BasemapTerrainContract = 'unified-dem-v1';
type BasemapLightPreset = 'dawn' | 'day' | 'dusk' | 'night';

export interface BasemapRenderConfig {
  id: BasemapId;
  label: string;
  styleUrl: string;
  visualFamily: BasemapVisualFamily;
  terrainContract: BasemapTerrainContract;
  lightPreset?: BasemapLightPreset;
}

type BasemapOption = BasemapRenderConfig;

// Stick to Mapbox-owned public styles so the app only pays for the same GL JS
// map usage it already has, without introducing custom Styles API churn. The
// two "Standard" entries are RedView themes: Mapbox Outdoors v12 recoloured
// client-side (see `features/map3d/lib/basemapThemes`).
const MAPBOX_BASEMAPS: readonly BasemapOption[] = [
  {
    id: 'standard',
    label: 'Standard (clair)',
    styleUrl: REDVIEW_TOPO_LIGHT_STYLE_URL,
    visualFamily: 'mapbox-classic-v12',
    terrainContract: 'unified-dem-v1',
  },
  {
    id: 'dark',
    label: 'Standard (sombre)',
    styleUrl: REDVIEW_TOPO_DARK_STYLE_URL,
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

// Vector basemaps (RedView themes / Outdoors) take the contour overlay;
// satellite imagery is too busy for it.
const CONTOUR_LINE_BASEMAPS: ReadonlySet<BasemapId> = new Set<BasemapId>(['standard', 'dark', 'topographic']);

export function basemapSupportsContourLines(id: BasemapId | null | undefined): boolean {
  return CONTOUR_LINE_BASEMAPS.has(normalizeBasemapId(id));
}

export function getBasemapGroundTone(id: BasemapId | null | undefined): 'light' | 'dark' {
  return normalizeBasemapId(id) === 'dark' ? 'dark' : 'light';
}

export function getBasemapStyleUrl(id: BasemapId | null | undefined): string {
  return getBasemapConfig(id).styleUrl;
}

export function getBasemapConfig(id: BasemapId | null | undefined): BasemapRenderConfig {
  const resolvedId = normalizeBasemapId(id);
  return MAPBOX_BASEMAPS.find((basemap) => basemap.id === resolvedId)
    ?? MAPBOX_BASEMAPS[0];
}