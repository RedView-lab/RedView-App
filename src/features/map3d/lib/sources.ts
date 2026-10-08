import { FRANCE_BOUNDS, DEM_SOURCE_MAXZOOM } from './ign.config';

/**
 * Taille de tuile logique qui fait demander à un overlay raster exactement les
 * tuiles de la pyramide DEM du terrain 3D.
 *
 * Mapbox charge les tuiles DEM du terrain à `floor(zoom − 1)` pour nos sources
 * raster-dem de 256 px (Terrain.getScaledDemTileSize() : 256 / GRID_DIM 128 ×
 * tuile proxy de 512 px = 1024), tandis qu'une source raster demande
 * `round(zoom + log2(512 / tileSize))` — `round(zoom + 1)` pour des tuiles de
 * 256 px, soit 2 à 3 niveaux plus profond que le terrain : 16 à 64× plus de
 * tuiles DEM à construire que le relief à l'écran. Avec 512·2^1,5 px, l'overlay
 * demande `round(zoom − 1,5) = floor(zoom − 1)` : exactement les tuiles que le
 * terrain a chargées.
 */
export const TERRAIN_ALIGNED_RASTER_TILE_SIZE = 512 * 2 * Math.SQRT2;

/** Zoom des tuiles DEM que Mapbox charge pour le terrain 3D à `zoom` (voir plus haut). */
export function terrainDemTileZoom(zoom: number): number {
  return Math.max(0, Math.floor(zoom - 1));
}

/**
 * Source DEM unifiée : DEM national haute résolution dans les régions couvertes,
 * AWS Terrarium (~30 m mondial) ailleurs. Traitée côté client par le Service
 * Worker (sw-dem.js), qui intercepte les requêtes /dem-tiles/.
 */
export const unifiedDEMSource = {
  id: 'unified-dem',
  type: 'raster-dem' as const,
  tiles: ['/dem-tiles/{z}/{x}/{y}'],
  // 256 px pour correspondre à la sortie du SW (DEM_TILE_SIZE dans config.js)
  tileSize: 256,
  encoding: 'mapbox' as const,
  // Sous z6, le DEM n'apporte aucun relief visible en vue mondiale, mais le
  // rendu demanderait quand même ~50 tuiles par session pour le maillage du
  // globe — bande passante gaspillée et trafic de DEM de repli mondial gaspillé.
  // Le terrain reste désactivé à l'échelle mondiale ; le SW court-circuite aussi z<4.
  minzoom: 6,
  maxzoom: DEM_SOURCE_MAXZOOM,
};

/**
 * Source d'orthophotos IGN — relayée par le Service Worker.
 * Le SW découpe les tuiles sur le polygone de la frontière française : les zones
 * hors de France sont transparentes et laissent voir le satellite Mapbox de
 * base aux frontières.
 *
 * minzoom=11 : en dessous (~75 m/px aux latitudes françaises), l'ortho IGN à
 * 20 cm ne se distingue pas visuellement de Mapbox Standard-Satellite, alors que
 * l'éventail de requêtes de tuiles sature la file WMTS de l'ortho pendant un
 * dézoom rapide et produit l'artefact « patchwork de tuiles manquantes ». Au-delà
 * de z11, l'overlay IGN entre en jeu en douceur (raster-fade-duration gère le
 * fondu enchaîné — voir layers.ts).
 */
export const ignOrthoSource = {
  id: 'ign-ortho',
  type: 'raster' as const,
  tiles: ['/ortho-tiles/{z}/{x}/{y}'],
  tileSize: 256,
  minzoom: 11,
  maxzoom: 19,
  bounds: FRANCE_BOUNDS,
  attribution: '&copy; IGN - Géoplateforme',
};

/**
 * Repli AWS Open Data Terrarium — utilisé quand le Service Worker est
 * indisponible (délai d'enregistrement dépassé, contrôleur jamais pris). Fournit
 * un terrain mondial à ~30 m directement depuis AWS S3 avec l'encodage natif
 * `terrarium`, que Mapbox GL v3 décode sur le GPU — sans pipeline SW.
 *
 * Le chemin SW unified-dem est toujours préféré, car il compose le LiDAR IGN
 * haute résolution sur la France et la Suisse. Cette source est le dernier
 * recours pour éviter une carte complètement plate.
 */
export const awsFallbackDEMSource = {
  id: 'aws-fallback-dem',
  type: 'raster-dem' as const,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium' as const,
  minzoom: 4,
  maxzoom: 14,  // le maximum natif d'AWS Terrarium est z14
};

/**
 * Mode « rapide » AWS Open Data Terrarium — à activer par le sélecteur de
 * qualité 3D (« 30 m (Rapide) »). Même pipeline raster-dem
 * qu'awsFallbackDEMSource, mais enregistré sous son propre identifiant de source
 * pour coexister avec le pipeline SW unifié. Permet de basculer instantanément
 * vers un DEM mondial décodé par le GPU qui ne dépend NI du Service Worker NI de
 * l'IGN — transitions parfaitement fluides, aucune latence de construction de
 * tuiles, moins de bande passante que le LiDAR IGN.
 */
export const awsFastDEMSource = {
  id: 'aws-fast-dem',
  type: 'raster-dem' as const,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium' as const,
  minzoom: 4,
  maxzoom: 14,
};

/**
 * Overlay d'orthophotos à très haute résolution (PCRS IGN 5 cm + THR 5–10 cm),
 * construit par le Service Worker (`public/sw-dem/sources/vhr-ortho.js`) et
 * dessiné juste au-dessus de Mapbox Satellite. En France, Mapbox Satellite est
 * l'ortho IGN 20 cm jusqu'à z19 (plus, dans quelques villes, un PCRS à z20
 * seulement — son propre z21 y est l'ortho 20 cm agrandie 4×). Les tuiles sans
 * couverture reviennent transparentes pour que l'imagerie Mapbox reste visible.
 *
 * z18–21, toujours en tuiles de 512 px (`r=2` ; le WMS rend n'importe quelle
 * taille : deux fois le détail pour le même nombre de tuiles, comme les tuiles
 * `@2x` de Mapbox Satellite, voir `satelliteTiles.ts`), pour qu'une tuile de
 * 256 px affichée sur jusqu'à 362 px d'écran ne descende jamais sous l'imagerie :
 * un cran de dézoom garde l'aspect 5 cm au lieu de retomber sur l'ortho 20 cm.
 * Le 5 cm est natif à z21 (le SW y sert du 256 px, Mapbox suréchantillonne au-delà).
 */
export const VHR_ORTHO_SOURCE_ID = 'rv-vhr-ortho';

export function buildVhrOrthoSource() {
  return {
    type: 'raster' as const,
    tiles: ['/vhr-tiles/{z}/{x}/{y}?r=2'],
    tileSize: 256,
    minzoom: 18,
    maxzoom: 21,
    bounds: FRANCE_BOUNDS,
    attribution: '&copy; IGN - Géoplateforme (PCRS, ortho THR)',
  };
}
