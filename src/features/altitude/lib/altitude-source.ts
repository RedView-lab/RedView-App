import type {
  AltitudeCategory,
  AltitudeColorMode,
} from '../types';
import { buildAltitudeColorExpression, MAX_ALTITUDE_M, MIN_ALTITUDE_M } from './altitude-config';
import { AltitudeDemSource, type AltitudeFallbackTiles } from './altitude-dem-source';

import {
  awsFastDEMSource,
  TERRAIN_ALIGNED_RASTER_TILE_SIZE,
  unifiedDEMSource,
} from '@/features/map3d/lib/sources';
import { mapboxRasterColorMix } from '@/features/map3d/lib/rasterColorMix';
import type { Dem3dQuality } from '@/features/map3d/lib/dem3dQualityBus';
import type { DemTileProfile } from '@/features/map3d/hooks/useMap/demTiles';

export const ALTITUDE_SOURCE_ID = 'altitude-tiles';
export const ALTITUDE_LAYER_ID = 'altitude-overlay';

/**
 * Les tuiles masquées par zone sont construites par le Service Worker (masque
 * de polygone par pixel) à partir du DEM qu'il met en cache : les bandes
 * hypsométriques n'y gagnent rien de z15 à z17, et Mapbox surzoome au-delà de
 * `maxzoom`.
 */
const ALTITUDE_ZONE_MAXZOOM = 14;

/**
 * La surcouche utilise exactement les tuiles de la pyramide DEM du terrain 3D
 * (z = floor(zoom − 1)) : chaque tuile est une tuile DEM que le terrain a déjà
 * chargée.
 */
const ALTITUDE_TILE_SIZE = TERRAIN_ALIGNED_RASTER_TILE_SIZE;

// raster-color-mix travaille sur des canaux normalisés 0..1 (×255 intégré), la
// mise à l'échelle RGB propre à Mapbox étant compensée (voir rasterColorMix.ts :
// sans cela, tout ce qui est sous ~29 m / ~96 m se décodait sous 0 et
// s'affichait comme niveau de la mer). Chaque tuile d'altitude est du
// Terrain-RGB de Mapbox : -10000 + (R·65536 + G·256 + B) · 0.1 (la source à
// DEM partagé réencode les tuiles Terrarium).
const MAPBOX_RGB_DECODE_MIX = mapboxRasterColorMix([1671168, 6528, 25.5, -10000]);
const ALTITUDE_DECODE_RANGE: [number, number] = [MIN_ALTITUDE_M, MAX_ALTITUDE_M];

/** Restriction de zone de la surcouche d'altitude (polygone de la zone d'analyse). */
export interface AltitudeZoneOptions {
  /** Empreinte stable de l'anneau du polygone — devient la clé de cache `?zone=`. */
  hash: string;
  /** [ouest, sud, est, nord] — `bounds` de la source raster Mapbox. */
  bounds: [number, number, number, number];
  /** Coordonnées de l'anneau à plat [lng, lat, ...] pour le masquage. */
  ring?: number[];
}

export interface AltitudeTileSourceOptions {
  zone?: AltitudeZoneOptions | null;
  /** Qualité active du terrain 3D — la surcouche lit le MÊME DEM que le terrain. */
  quality?: Dem3dQuality;
  /** Profil DEM HD actif (surface 0,40 m ou sol nu 1 m). */
  profile?: DemTileProfile;
}

interface ResolvedAltitudeSource {
  quality: Dem3dQuality;
  profile: DemTileProfile;
  zone: AltitudeZoneOptions | null;
}

function resolveAltitudeSource(options: AltitudeTileSourceOptions | undefined): ResolvedAltitudeSource {
  return {
    quality: options?.quality ?? 'fast-30m',
    profile: options?.profile === 'terrain' ? 'terrain' : 'default',
    zone: options?.zone ?? null,
  };
}

/** Vrai quand les tuiles passent par le Service Worker (chemin masqué par zone). */
export function altitudeUsesServiceWorker(options: AltitudeTileSourceOptions | undefined): boolean {
  return Boolean(resolveAltitudeSource(options).zone);
}

/** Change chaque fois que la source doit être remplacée (retrait + réajout). */
export function buildAltitudeSourceKey(options: AltitudeTileSourceOptions | undefined): string {
  const { quality, profile, zone } = resolveAltitudeSource(options);
  return zone ? `zone:${zone.hash}:${profile}` : `dem:${quality}:${profile}`;
}

function swAltitudeTileUrl(profile: DemTileProfile, zone: AltitudeZoneOptions | null): string {
  const params = new URLSearchParams();
  if (profile === 'terrain') params.set('rv-dem-profile', 'terrain');
  if (zone) params.set('zone', zone.hash);
  const query = params.toString();
  return `/altitude-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`;
}

/**
 * - Sans zone (cas courant) : `AltitudeDemSource`, qui lit les tuiles DEM que le
 *   terrain 3D a déjà décodées (AWS Terrarium fast-30m ou DEM HD du SW) — pas de
 *   second téléchargement, les couleurs arrivent dans la même image que le
 *   relief. Les URL de tuiles ne servent que de repli quand le terrain n'a pas
 *   une tuile.
 * - Avec zone : `/altitude-tiles?zone=<hash>`, masquées par le SW ; `bounds`
 *   empêche Mapbox de demander des tuiles hors de l'emprise du polygone.
 */
export function buildAltitudeSource(options?: AltitudeTileSourceOptions) {
  const { quality, profile, zone } = resolveAltitudeSource(options);
  if (zone) {
    return {
      type: 'raster' as const,
      tiles: [swAltitudeTileUrl(profile, zone)],
      tileSize: ALTITUDE_TILE_SIZE,
      minzoom: unifiedDEMSource.minzoom,
      maxzoom: ALTITUDE_ZONE_MAXZOOM,
      bounds: zone.bounds,
    };
  }
  const terrainSource = quality === 'fast-30m' ? awsFastDEMSource : unifiedDEMSource;
  const fallback: AltitudeFallbackTiles = quality === 'fast-30m'
    ? { url: awsFastDEMSource.tiles[0], encoding: 'terrarium' }
    : { url: swAltitudeTileUrl(profile, null), encoding: 'mapbox' };
  return new AltitudeDemSource({
    id: ALTITUDE_SOURCE_ID,
    tileSize: ALTITUDE_TILE_SIZE,
    minzoom: terrainSource.minzoom,
    maxzoom: terrainSource.maxzoom,
    fallback,
  });
}

export function buildAltitudeLayer(
  opacity: number,
  colorMode: AltitudeColorMode,
  categories: AltitudeCategory[],
  hiddenIds: ReadonlySet<string> | string[] | undefined,
) {
  return {
    id: ALTITUDE_LAYER_ID,
    type: 'raster' as const,
    source: ALTITUDE_SOURCE_ID,
    slot: 'top',
    paint: {
      'raster-opacity': opacity,
      'raster-resampling': 'linear' as const,
      'raster-fade-duration': 0,
      'raster-color-mix': MAPBOX_RGB_DECODE_MIX,
      'raster-color-range': ALTITUDE_DECODE_RANGE,
      'raster-color': buildAltitudeColorExpression(categories, colorMode, hiddenIds),
      // Les couleurs de la légende doivent rester exactes sous l'éclairage de crépuscule / nuit.
      'raster-emissive-strength': 1,
    },
  };
}

export { buildAltitudeColorExpression };
