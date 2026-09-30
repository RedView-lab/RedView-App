import type { FogSpecification, LightsSpecification, Map as MapboxMap } from 'mapbox-gl';
import { FOG_CONFIG } from './mapbox.config';

/**
 * Map environment bus (jour / crépuscule / nuit).
 *
 * Decouples the ControlPanel "Environnement" selector from the map3d
 * lifecycle. This module is the single owner of the scene lights and fog:
 *   - the style bootstrap applies it after every `setStyle` (lights and fog
 *     are reset by a style swap);
 *   - `useMapSubscriptions` re-applies it live when the environment or the
 *     sun override changes;
 *   - the sunlight feature only publishes a sun direction override instead of
 *     calling `map.setLights()` itself.
 *
 * Mapbox GL v3 lights every 2D layer (fill, line, raster, background…) whose
 * `*-emissive-strength` is 0, so darkening the ambient/directional lights
 * dims the basemap while app layers declaring `*-emissive-strength: 1`
 * (routes, POIs, slope/altitude/weather overlays) keep their true colours.
 * Symbols default to emissive, so labels stay readable at night.
 */

export type MapEnvironment = 'day' | 'dusk' | 'night';

export const DEFAULT_MAP_ENVIRONMENT: MapEnvironment = 'day';

export const MAP_ENVIRONMENT_OPTIONS: ReadonlyArray<{ value: MapEnvironment; label: string }> = [
  { value: 'day', label: 'Jour' },
  { value: 'dusk', label: 'Crépuscule' },
  { value: 'night', label: 'Nuit' },
];

interface EnvironmentLighting {
  ambient: { color: string; intensity: number };
  directional: {
    color: string;
    intensity: number;
    /** [azimuth°, polar°] — polar 0 = zenith, 90 = horizon. */
    direction: [number, number];
  };
  fog: FogSpecification;
}

const ENVIRONMENTS: Record<MapEnvironment, EnvironmentLighting> = {
  // Historical neutral look (ground radiance ≈ 0.89): unchanged for users.
  day: {
    ambient: { color: '#ffffff', intensity: 0.34 },
    directional: { color: '#ffffff', intensity: 0.55, direction: [180, 38] },
    fog: FOG_CONFIG as FogSpecification,
  },
  // Low warm sun from the west, rosy ambient (ground radiance ≈ 0.6).
  dusk: {
    ambient: { color: '#e6ccd4', intensity: 0.3 },
    directional: { color: '#ffa060', intensity: 0.6, direction: [255, 75] },
    fog: {
      range: [0.6, 8.5],
      color: 'rgb(255, 170, 130)',
      'high-color': 'rgb(120, 70, 140)',
      'horizon-blend': 0.12,
      'space-color': 'rgb(40, 30, 70)',
      'star-intensity': 0.15,
    },
  },
  // Cool moonlight (ground radiance ≈ 0.35): dark but the terrain stays legible.
  night: {
    ambient: { color: '#a0b3ed', intensity: 0.14 },
    directional: { color: '#9fb4ff', intensity: 0.15, direction: [200, 45] },
    fog: {
      range: [0.6, 8.5],
      color: 'rgb(22, 30, 58)',
      'high-color': 'rgb(10, 16, 40)',
      'horizon-blend': 0.08,
      'space-color': 'rgb(4, 6, 18)',
      'star-intensity': 0.6,
    },
  },
};

/**
 * "Jour" haze for dark basemaps: the warm day fog reads as a sunset glow over
 * a night-toned ground, so dark themes get a cool, low-key horizon instead.
 * Dusk / night keep their own fog whatever the basemap.
 */
const DARK_BASEMAP_DAY_FOG: FogSpecification = {
  range: [0.6, 8.5],
  color: 'rgb(40, 50, 68)',
  'high-color': 'rgb(28, 44, 86)',
  'horizon-blend': 0.1,
  'space-color': 'rgb(8, 12, 26)',
  'star-intensity': 0.25,
};

export type MapBasemapTone = 'light' | 'dark';

let currentBasemapTone: MapBasemapTone = 'light';

/**
 * Set by the style bootstrap before it applies the environment. No notify:
 * the tone only changes with a basemap switch, which re-applies the fog.
 */
export function setMapEnvironmentBasemapTone(tone: MapBasemapTone): void {
  currentBasemapTone = tone;
}

/** Real sun direction published by the sunlight feature while it is enabled. */
export interface SunLightOverride {
  azimuthDeg: number;
  altitudeDeg: number;
  castShadows: boolean;
}

const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set(['day', 'dusk', 'night']);

export function normalizeMapEnvironment(value: string | null | undefined): MapEnvironment {
  return typeof value === 'string' && VALID_ENVIRONMENTS.has(value)
    ? (value as MapEnvironment)
    : DEFAULT_MAP_ENVIRONMENT;
}

let currentEnvironment: MapEnvironment = DEFAULT_MAP_ENVIRONMENT;
let currentSunOverride: SunLightOverride | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try { listener(); } catch (err) { console.warn('[mapEnvironment] listener failed', err); }
  }
}

export function getActiveMapEnvironment(): MapEnvironment {
  return currentEnvironment;
}

export function setActiveMapEnvironment(next: string | null | undefined): void {
  const normalized = normalizeMapEnvironment(next);
  if (normalized === currentEnvironment) return;
  currentEnvironment = normalized;
  notify();
}

export function setSunLightOverride(next: SunLightOverride | null): void {
  const prev = currentSunOverride;
  if (
    prev === next
    || (prev && next
      && Math.abs(prev.azimuthDeg - next.azimuthDeg) < 0.01
      && Math.abs(prev.altitudeDeg - next.altitudeDeg) < 0.01
      && prev.castShadows === next.castShadows)
  ) {
    return;
  }
  currentSunOverride = next;
  notify();
}

/** Fires on environment or sun override change. */
export function subscribeMapEnvironment(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function buildMapEnvironmentLights(
  environment: MapEnvironment,
  sun: SunLightOverride | null,
): LightsSpecification[] {
  const { ambient, directional } = ENVIRONMENTS[environment];
  let direction = directional.direction;
  if (sun) {
    const clampedAltitude = Math.max(-12, Math.min(85, sun.altitudeDeg));
    direction = [sun.azimuthDeg, Math.min(88, Math.max(4, 90 - clampedAltitude))];
  }
  const castShadows = sun?.castShadows ?? false;
  return [
    { id: 'ambient', type: 'ambient', properties: { color: ambient.color, intensity: ambient.intensity } },
    {
      id: 'directional',
      type: 'directional',
      properties: {
        color: directional.color,
        intensity: directional.intensity,
        direction,
        // `cast-shadows` triggers a per-frame shadow-map pass over every
        // fill-extrusion building: only enabled by the sunlight "Ombres" toggle.
        'cast-shadows': castShadows,
        'shadow-intensity': castShadows ? 0.62 : 0,
      },
    },
  ];
}

export function getMapEnvironmentFog(environment: MapEnvironment): FogSpecification {
  if (environment === 'day' && currentBasemapTone === 'dark') return DARK_BASEMAP_DAY_FOG;
  return ENVIRONMENTS[environment].fog;
}

/** Applies the active environment (lights + fog) to the map. Best-effort. */
export function applyMapEnvironment(map: MapboxMap): void {
  try {
    map.setFog(getMapEnvironmentFog(currentEnvironment));
  } catch {
    /* style may still be finishing its internal graph rebuild */
  }
  try {
    map.setLights(buildMapEnvironmentLights(currentEnvironment, currentSunOverride));
  } catch {
    /* style not ready — the next style bootstrap re-applies */
  }
}
