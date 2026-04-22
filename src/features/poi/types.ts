// ── POI categories relevant to ultra cyclists / outdoor sports ─────────
//
// Aligné sur la taxonomie du panneau Itinerary (Figma) ET sur les tags
// indexés par le serveur self-hosted (`redview-poi-server/filter.txt`).

export const POI_CATEGORIES = [
  'drinking_water',
  'toilets',
  'fuel',
  'fast_food',
  'cafe',
  'bar',
  'restaurant',
  'bakery',
  'supermarket',
  'convenience',
  'bicycle',
  'bicycle_repair',
  'hotel',
  'alpine_hut',
  'camp_site',
  'shelter',
  'pharmacy',
  'hospital',
] as const;

export type PoiCategory = (typeof POI_CATEGORIES)[number];

/** Visual grouping for the UI panel */
export interface PoiGroup {
  label: string;
  categories: PoiCategory[];
}

export const POI_GROUPS: PoiGroup[] = [
  { label: 'Eau', categories: ['drinking_water'] },
  { label: 'Alimentation', categories: ['bakery', 'convenience', 'supermarket'] },
  { label: 'Restauration', categories: ['restaurant', 'fast_food', 'cafe', 'bar'] },
  { label: 'Vélo', categories: ['bicycle', 'bicycle_repair'] },
  { label: 'Hébergement', categories: ['hotel', 'alpine_hut', 'camp_site', 'shelter'] },
  { label: 'Services', categories: ['toilets', 'fuel', 'pharmacy', 'hospital'] },
];

/** Human-readable labels (FR) */
export const POI_LABELS: Record<PoiCategory, string> = {
  drinking_water: 'Fontaine / eau',
  toilets: 'Toilettes',
  fuel: 'Station-service',
  fast_food: 'Fast-food',
  cafe: 'Café',
  bar: 'Bar',
  restaurant: 'Restaurant',
  bakery: 'Boulangerie',
  supermarket: 'Supermarché',
  convenience: 'Supérette',
  bicycle: 'Magasin vélo',
  bicycle_repair: 'Réparation vélo',
  hotel: 'Hôtel',
  alpine_hut: 'Refuge',
  camp_site: 'Camping',
  shelter: 'Abri',
  pharmacy: 'Pharmacie',
  hospital: 'Hôpital',
};

/** Colors per category for icons */
export const POI_COLORS: Record<PoiCategory, string> = {
  drinking_water: '#38bdf8',
  toilets: '#a78bfa',
  fuel: '#facc15',
  fast_food: '#fb7185',
  cafe: '#a16207',
  bar: '#c084fc',
  restaurant: '#ef4444',
  bakery: '#fbbf24',
  supermarket: '#f97316',
  convenience: '#fb923c',
  bicycle: '#34d399',
  bicycle_repair: '#10b981',
  hotel: '#60a5fa',
  alpine_hut: '#15803d',
  camp_site: '#22c55e',
  shelter: '#94a3b8',
  pharmacy: '#f472b6',
  hospital: '#dc2626',
};

/** A single POI feature */
export interface PoiFeature {
  id: number;
  lat: number;
  lon: number;
  category: PoiCategory;
  name: string | null;
  tags: Record<string, string>;
}

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
}
