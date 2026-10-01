// ── POI categories relevant to ultra cyclists / outdoor sports ─────────
//
// La liste des catégories est dérivée de `poi-taxonomy.json`, la source de
// vérité partagée avec l'importeur OSM du serveur POI. Le type `PoiCategory`
// reste une union littérale explicite : c'est ce qui garantit à la
// compilation que les libellés, icônes et mappings du panneau couvrent bien
// toutes les catégories réellement indexées en base.

import {
  POI_TAXONOMY,
  POI_TAXONOMY_ICON,
  POI_TAXONOMY_LABELS,
  POI_TAXONOMY_GROUP,
} from './poi-taxonomy';

export const POI_CATEGORIES = [
  // Eau
  'drinking_water',
  'water_point',
  'water_tap',
  'spring',
  'fountain',
  // Ravitaillement
  'supermarket',
  'convenience',
  'bakery',
  'butcher',
  'marketplace',
  'restaurant',
  'fast_food',
  'cafe',
  'bar',
  'pub',
  'ice_cream',
  'vending_machine',
  // Dormir / bivouac
  'hotel',
  'alpine_hut',
  'wilderness_hut',
  'shelter',
  'camp_site',
  'caravan_site',
  // Vélo & réparation
  'bicycle',
  'bicycle_repair',
  'compressed_air',
  'charging_station',
  'outdoor_shop',
  // Santé & sécurité
  'pharmacy',
  'hospital',
  'clinic',
  'doctors',
  'defibrillator',
  'police',
  // Transport & évacuation
  'train_station',
  'bus_station',
  'ferry_terminal',
  // Services
  'toilets',
  'shower',
  'fuel',
  'atm',
  'post_office',
  'laundry',
  // Paysage & cols
  'pass',
  'viewpoint',
  'picnic_site',
] as const;

export type PoiCategory = (typeof POI_CATEGORIES)[number];

/** Visual grouping for the UI panel */
export interface PoiGroup {
  label: string;
  categories: PoiCategory[];
}

/** Groupes dérivés de la taxonomie (ordre du fichier source). */
export const POI_GROUPS: PoiGroup[] = POI_TAXONOMY.groups.map((group) => ({
  label: group.label,
  categories: POI_CATEGORIES.filter((key) => POI_TAXONOMY_GROUP[key] === group.key),
})).filter((group) => group.categories.length > 0);

/**
 * Human-readable labels (FR).
 *
 * Construits depuis `poi-taxonomy.json` : si une catégorie est ajoutée au
 * type `PoiCategory` sans être déclarée dans le JSON, le libellé retombe sur
 * la clé brute au lieu d'échouer silencieusement.
 */
export const POI_LABELS: Record<PoiCategory, string> = Object.fromEntries(
  POI_CATEGORIES.map((key) => [key, POI_TAXONOMY_LABELS[key] ?? key]),
) as Record<PoiCategory, string>;

/** Nom logique d'icône par catégorie (résolu en URL par `lib/poi-icons`). */
export const POI_ICON_NAMES: Record<PoiCategory, string> = Object.fromEntries(
  POI_CATEGORIES.map((key) => [key, POI_TAXONOMY_ICON[key] ?? 'fallback']),
) as Record<PoiCategory, string>;

/** A single POI feature */
export interface PoiFeature {
  id: number;
  lat: number;
  lon: number;
  category: PoiCategory;
  name: string | null;
  tags: Record<string, string>;
  favorite?: boolean;
  pauseDurationMin?: number | null;
  /** Type d'objet OSM d'origine, renvoyé par le serveur POI. */
  osmType?: 'node' | 'way' | 'relation';
  /** Base d'origine (null = OSM), renvoyée par une base POI enrichie. */
  source?: string | null;
  /** Confiance de la déduplication multi-sources (0..1), null pour OSM. */
  srcConfidence?: number | null;
  /** Favori posé à la main ou par le tri automatique (absent = manuel). */
  favoriteSource?: PoiFavoriteSource;
  /** Règle du tri automatique qui a retenu ce favori. */
  autoReason?: PoiAutoSortReason;
}

export type PoiFavoriteSource = 'auto' | 'manual';

/** Pourquoi le tri automatique a mis un POI en favori. */
export type PoiAutoSortReason =
  | 'water'
  | 'resupply'
  | 'bakery'
  | 'meal'
  | 'night'
  | 'hotel'
  | 'gap6h';

/** Backend response (Fastify /bbox and /corridor) */
export interface PoiApiResponse {
  features: PoiFeature[];
}

/** Parsed GPX route with optional elevation metadata when available. */
export interface GpxRoute {
  name: string | null;
  points: {
    lat: number;
    lon: number;
    distanceM?: number;
    elevationM?: number | null;
    gradientPct?: number | null;
  }[];
  /** Attribut `creator` de la balise <gpx> (ex. « RedView »), quand présent. */
  creator?: string | null;
  /** Points <wpt> du fichier (POI, points de passage, départ/arrivée). */
  waypoints?: GpxWaypoint[];
}

/** `tags.source` des POI issus d'un import GPX (ids négatifs, hors base POI). */
export const GPX_IMPORT_POI_SOURCE = 'redview_gpx_import';

/** Un élément <wpt> brut lu dans un GPX. */
export interface GpxWaypoint {
  lat: number;
  lon: number;
  elevationM: number | null;
  name: string | null;
  type: string | null;
  sym: string | null;
  desc: string | null;
}
