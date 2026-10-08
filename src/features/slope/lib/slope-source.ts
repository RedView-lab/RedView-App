import { TERRAIN_ALIGNED_RASTER_TILE_SIZE } from '@/features/map3d/lib/sources';
import { mapboxRasterColorMix } from '@/features/map3d/lib/rasterColorMix';
import type { SlopeColorMode, SlopeCategory, SlopeDemProfile } from '../types';
import { buildSlopeColorExpression, MAX_SLOPE_DEG } from './slope-config';

// ── Identifiants de source et de couche ───────────────────────────────

export const SLOPE_SOURCE_ID = 'slope-tiles';
export const SLOPE_LAYER_ID = 'slope-overlay';

/** Restriction de zone de la surcouche de pente (polygone de la zone d'analyse). */
export interface SlopeZoneOptions {
  /** Empreinte stable de l'anneau du polygone — devient la clé de cache `?zone=`. */
  hash: string;
  /** [ouest, sud, est, nord] — `bounds` de la source raster Mapbox. */
  bounds: [number, number, number, number];
  /** Coordonnées de l'anneau à plat [lng, lat, ...] pour le masquage. */
  ring?: number[];
}

export interface SlopeTileSourceOptions {
  demProfile: SlopeDemProfile;
  resolutionFactor: number;
  zone?: SlopeZoneOptions | null;
  sourceDem?: 'fast-30m' | 'hd' | '30m';
}

const DEFAULT_SOURCE_OPTIONS: SlopeTileSourceOptions = {
  demProfile: 'default',
  resolutionFactor: 1,
};

export function buildSlopeSourceKey(options: SlopeTileSourceOptions | undefined): string {
  const resolved = options ?? DEFAULT_SOURCE_OPTIONS;
  const zoneKey = resolved.zone ? `:zone-${resolved.zone.hash}` : '';
  const sourceDemKey = resolved.sourceDem ? `:src-${resolved.sourceDem}` : '';
  return `${resolved.demProfile}:${resolved.resolutionFactor}${sourceDemKey}${zoneKey}`;
}

function resolveSlopeMaxZoom(options: SlopeTileSourceOptions): number {
  // Résolution 30 m (fast-30m / 30m) : plafonnée à z13 (~13,5 m/px à 45° de latitude) pour éviter un suréchantillonnage en escalier
  if (options.sourceDem === 'fast-30m' || options.sourceDem === '30m') {
    return 13;
  }
  // Analysis zone: pipeline pre-computes at z14, draped seamlessly on GPU beyond
  if (options.zone) {
    return 14;
  }
  // Terrain LiDAR 1 m :
  if (options.demProfile === 'terrain') {
    return 16;
  }
  // Surface LiDAR 0,40 m : plafonnée à z16 (~1,69 m/px à 45° de latitude) pour éviter les artefacts de suréchantillonnage du WMS
  return 16;
}

// ── Définition de la source raster ────────────────────────────────────
//
// L'URL de tuile ne varie qu'avec le profil DEM + `resFactor` + l'empreinte de
// la zone d'analyse (les paramètres qui changent vraiment les pixels de
// pente). Le mode de couleur, les seuils de catégorie et la visibilité des
// bandes sont appliqués côté GPU via les propriétés de peinture raster-color :
// les changer n'invalide jamais le cache de tuiles du SW et ne redemande
// jamais de tuile — `setPaintProperty` est instantané et synchrone sur le GPU.
//
// Pyramide de tuiles : la surcouche demande exactement les tuiles de la
// pyramide DEM du terrain 3D (TERRAIN_ALIGNED_RASTER_TILE_SIZE,
// z = floor(zoom − 1)), donc le Service Worker calcule la tuile de pente z/x/y
// à partir de la tuile DEM z/x/y que le maillage du terrain a déjà chargée —
// aucun DEM propre à construire. Avec des tuiles de 256 px, elle demandait
// round(zoom + 1) : 16 à 64× plus de tuiles DEM que le relief à l'écran,
// chacune une construction IGN. Le SW renvoie des tuiles de 512 px (Catmull-Rom
// 2× de la pente à la résolution du DEM) que Mapbox dessine sur 1024–2048 px.
//
// Mode zone : `bounds` empêche Mapbox de demander la MOINDRE tuile hors de
// l'emprise du polygone, et `?zone=<hash>` fait que le Service Worker (a)
// refuse les tuiles qui ne le coupent pas avant toute requête DEM et (b)
// masque en alpha les tuiles partiellement couvertes au polygone exact.
// L'empreinte dans l'URL isole aussi les tuiles masquées des tuiles non
// masquées dans chaque niveau de cache.

export function buildSlopeTileSource(options: SlopeTileSourceOptions = DEFAULT_SOURCE_OPTIONS) {
  const params = new URLSearchParams();
  if (options.resolutionFactor > 1) {
    params.set('res', String(options.resolutionFactor));
  }
  if (options.demProfile === 'terrain') {
    params.set('rv-dem-profile', 'terrain');
  }
  if (options.sourceDem) {
    params.set('source-dem', options.sourceDem);
  }
  if (options.zone) {
    params.set('zone', options.zone.hash);
  }
  const query = params.toString();
  const maxzoom = resolveSlopeMaxZoom(options);
  const source: {
    type: 'raster';
    tiles: string[];
    tileSize: number;
    minzoom: number;
    maxzoom: number;
    bounds?: [number, number, number, number];
  } = {
    type: 'raster',
    tiles: [`/slope-tiles/{z}/{x}/{y}${query ? `?${query}` : ''}`],
    // Les tuiles de zone gardent la grille de 256 px du pipeline z14.
    tileSize: options.zone ? 256 : TERRAIN_ALIGNED_RASTER_TILE_SIZE,
    minzoom: 4,
    maxzoom,
  };
  if (options.zone) {
    source.bounds = options.zone.bounds;
  }
  return source;
}

// ── Construction de la définition de couche ───────────────────────────
//
// Encodage PNG du SW (gamma racine, un seul canal — PNG gris + alpha, décodé
// en R = G = B) :
//   R = round(sqrt(deg / 90) * 255)
//   A = 0 sur NoData, 255 sinon
//
// raster-color-mix [90, 0, 0, 0] décode R → [0, 90] en unités perceptives.
// La valeur réelle en degrés est retrouvée dans `buildSlopeColorExpression`,
// qui transforme chaque position de palier via
// `degToEncoded(deg) = sqrt(deg/90) * 90` pour que les seuils du dégradé
// tombent sur la bonne raster-value.
//
// Pourquoi un seul canal : le rééchantillonnage bilinéaire
// `raster-resampling: 'linear'` filtre chaque canal PNG indépendamment.
// L'ancien empaquetage RG sur 16 bits produisait un moiré régulier en points /
// grille partout où R changeait entre pixels voisins (tous les ~0,35°) : le
// point milieu bilinéaire (R, G) se décode en une valeur très fausse à la
// frontière d'octet. Avec un seul canal + gamma racine, l'échantillon
// bilinéaire est toujours une interpolation douce de la rampe perceptive : la
// surcouche montre le signal brut du DEM à 1 m comme un dégradé continu et net.
//
// slot : 'top' — doit être le slot de la couche ortho IGN pour que la
// surcouche peigne AU-DESSUS de l'orthophoto. Avec slot : 'middle', les tuiles
// ortho masquent entièrement le raster de pente en France et l'utilisateur ne
// voit rien.

// La mise à l'échelle RGB de −0,29 % de Mapbox est compensée (rasterColorMix.ts)
// pour que les seuils des bandes tombent sur le degré exact.
const SLOPE_DECODE_MIX = mapboxRasterColorMix([MAX_SLOPE_DEG, 0, 0, 0]);
const SLOPE_DECODE_RANGE: [number, number] = [0, MAX_SLOPE_DEG];

export function buildSlopeLayer(
  opacity: number,
  colorMode: SlopeColorMode,
  categories: SlopeCategory[],
  hiddenIds?: ReadonlySet<string> | string[],
) {
  return {
    id: SLOPE_LAYER_ID,
    type: 'raster' as const,
    source: SLOPE_SOURCE_ID,
    slot: 'top',
    paint: {
      'raster-opacity': opacity,
      // Le rééchantillonnage linéaire adoucit les transitions entre bandes en
      // vue inclinée. Le plus proche voisin produisait des escaliers de pixels
      // qu'on prenait pour des erreurs de données.
      'raster-resampling': 'linear' as const,
      'raster-fade-duration': 0,
      'raster-color-mix': SLOPE_DECODE_MIX,
      'raster-color-range': SLOPE_DECODE_RANGE,
      'raster-color': buildSlopeColorExpression(categories, colorMode, hiddenIds),
      // Les couleurs de la légende doivent rester exactes sous l'éclairage de crépuscule / nuit.
      'raster-emissive-strength': 1,
    },
  };
}

// Réexporté pour que les appelants (le hook) puissent reconstruire seulement
// l'expression de couleur quand la catégorie / le mode / l'état masqué change,
// sans toucher à la source.
export { buildSlopeColorExpression };
