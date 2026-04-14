// ── POI categories relevant to ultra cyclists / outdoor sports ─────────

export const POI_CATEGORIES = [
  'drinking_water',
  'bakery',
  'convenience',
  'supermarket',
  'bicycle',
  'bicycle_repair',
  'toilets',
  'shelter',
  'camp_site',
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
  { label: 'Vélo', categories: ['bicycle', 'bicycle_repair'] },
  { label: 'Services', categories: ['toilets', 'shelter', 'pharmacy', 'hospital'] },
  { label: 'Bivouac', categories: ['camp_site'] },
];

/** Human-readable labels */
export const POI_LABELS: Record<PoiCategory, string> = {
  drinking_water: 'Fontaine / eau',
  bakery: 'Boulangerie',
  convenience: 'Supérette',
  supermarket: 'Supermarché',
  bicycle: 'Magasin vélo',
  bicycle_repair: 'Réparation vélo',
  toilets: 'Toilettes',
  shelter: 'Abri',
  camp_site: 'Camping',
  pharmacy: 'Pharmacie',
  hospital: 'Hôpital',
};

/** Colors per category for icons */
export const POI_COLORS: Record<PoiCategory, string> = {
  drinking_water: '#38bdf8',
  bakery: '#fbbf24',
  convenience: '#fb923c',
  supermarket: '#f97316',
  bicycle: '#34d399',
  bicycle_repair: '#10b981',
  toilets: '#a78bfa',
  shelter: '#94a3b8',
  camp_site: '#22c55e',
  pharmacy: '#f472b6',
  hospital: '#ef4444',
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

/** Overpass API JSON response element */
export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: OverpassElement[];
}
