import type { FogSpecification, LightsSpecification, Map as MapboxMap } from 'mapbox-gl';
import { FOG_CONFIG } from './mapbox.config';

/**
 * Bus de l'environnement de la carte (jour / crépuscule / nuit).
 *
 * Découple le sélecteur « Environnement » du panneau de contrôle du cycle de vie
 * de map3d. Ce module est le seul propriétaire des lumières et du brouillard de
 * la scène :
 *   - le bootstrap du style l'applique après chaque `setStyle` (un changement de
 *     style réinitialise lumières et brouillard) ;
 *   - `useMapSubscriptions` le réapplique en direct quand l'environnement ou le
 *     forçage du soleil change ;
 *   - la fonction d'ensoleillement ne publie qu'un forçage de direction du
 *     soleil au lieu d'appeler elle-même `map.setLights()`.
 *
 * Mapbox GL v3 éclaire chaque calque 2D (fill, line, raster, background…) dont
 * le `*-emissive-strength` vaut 0 : assombrir les lumières ambiante /
 * directionnelle atténue le fond de carte, tandis que les calques de l'app qui
 * déclarent `*-emissive-strength: 1` (itinéraires, POI, overlays pente /
 * altitude / météo) gardent leurs vraies couleurs. Les symboles sont émissifs
 * par défaut : les libellés restent lisibles la nuit.
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
  // Aspect neutre historique (radiance du sol ≈ 0,89) : inchangé pour les utilisateurs.
  day: {
    ambient: { color: '#ffffff', intensity: 0.34 },
    directional: { color: '#ffffff', intensity: 0.55, direction: [180, 38] },
    fog: FOG_CONFIG as FogSpecification,
  },
  // Soleil bas et chaud venant de l'ouest, ambiance rosée (radiance du sol ≈ 0,6).
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
  // Clair de lune froid (radiance du sol ≈ 0,35) : sombre, mais le terrain reste lisible.
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

/** Vraie direction du soleil publiée par la fonction d'ensoleillement quand elle est active. */
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

/** Déclenché au changement d'environnement ou de forçage du soleil. */
export function subscribeMapEnvironment(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function buildMapEnvironmentLights(
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
        // `cast-shadows` déclenche à chaque image une passe de carte d'ombres sur
        // chaque bâtiment fill-extrusion : activé seulement par la bascule
        // « Ombres » de l'ensoleillement.
        'cast-shadows': castShadows,
        'shadow-intensity': castShadows ? 0.62 : 0,
      },
    },
  ];
}

function getMapEnvironmentFog(environment: MapEnvironment): FogSpecification {
  return ENVIRONMENTS[environment].fog;
}

/** Applique à la carte l'environnement actif (lumières + brouillard). Au mieux. */
export function applyMapEnvironment(map: MapboxMap): void {
  try {
    map.setFog(getMapEnvironmentFog(currentEnvironment));
  } catch {
    /* le style termine peut-être encore la reconstruction de son graphe interne */
  }
  try {
    map.setLights(buildMapEnvironmentLights(currentEnvironment, currentSunOverride));
  } catch {
    /* style pas prêt — le prochain bootstrap du style le réappliquera */
  }
}
