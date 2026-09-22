/**
 * Taxonomie POI — chargement du fichier source unique.
 *
 * `poi-taxonomy.json` est la source de vérité partagée entre :
 *   - le client (ce module) : libellés, groupes, icônes, filtres UI ;
 *   - l'importeur OSM du serveur POI (`server/poi-ingest/import-osm.mjs`) :
 *     correspondance tag OSM → catégorie pour la construction de la base.
 *
 * Les deux doivent rester strictement synchronisés : c'est pourquoi le JSON
 * est déployé tel quel sur le VPS à côté de l'importeur.
 *
 * ⚠️ Ajouter une catégorie ici ne suffit pas : il faut aussi l'ajouter à
 * `PoiCategory` (./types.ts) et au mapping du panneau
 * (`PANEL_TO_FEATURE_POI` dans itineraryPanel/hooks/useItineraryPoiMap.ts et
 * `FEATURE_TO_PANEL_POI` dans itineraryPanel/lib/schedule/poi-to-timeline.ts),
 * sinon elle sera indexée en base mais impossible à activer dans l'UI.
 */
import rawTaxonomy from './poi-taxonomy.json';

/** Une condition de tag : égalité (`v`) ou appartenance (`in`). */
export interface PoiTagCondition {
  k: string;
  v?: string;
  in?: string[];
}

/** Un tableau de conditions = un AND. */
export type PoiTagRule = PoiTagCondition[];

export interface PoiTaxonomyCategory {
  key: string;
  label: string;
  group: string;
  icon: string;
  /**
   * `false` = indexée en base mais non exposée dans l'app (voir $uiComment
   * du JSON). Absent = affichée.
   */
  ui?: boolean;
  rules: PoiTagRule[];
}

export interface PoiTaxonomyGroup {
  key: string;
  label: string;
}

export interface PoiTaxonomy {
  version: number;
  groups: PoiTaxonomyGroup[];
  categories: PoiTaxonomyCategory[];
  keepTags: string[];
}

export const POI_TAXONOMY = rawTaxonomy as unknown as PoiTaxonomy;

/** Toutes les clés de catégories servies par la base POI. */
export const POI_TAXONOMY_KEYS: string[] = POI_TAXONOMY.categories.map((c) => c.key);

/** Libellé FR par clé de catégorie. */
export const POI_TAXONOMY_LABELS: Record<string, string> = Object.fromEntries(
  POI_TAXONOMY.categories.map((c) => [c.key, c.label]),
);

/** Nom logique d'icône par clé de catégorie (résolu en URL par poi-icons). */
export const POI_TAXONOMY_ICON: Record<string, string> = Object.fromEntries(
  POI_TAXONOMY.categories.map((c) => [c.key, c.icon]),
);

/** Groupe d'appartenance par clé de catégorie. */
export const POI_TAXONOMY_GROUP: Record<string, string> = Object.fromEntries(
  POI_TAXONOMY.categories.map((c) => [c.key, c.group]),
);

/** Filtres Overpass (`nwr["k"="v"]`) pour une catégorie donnée. */
export function buildOverpassFilters(categoryKey: string): string[] {
  const cat = POI_TAXONOMY.categories.find((c) => c.key === categoryKey);
  if (!cat) return [];
  const out: string[] = [];
  for (const rule of cat.rules) {
    if (rule.length === 1) {
      const { k, v, in: values } = rule[0]!;
      if (v != null) out.push(`["${k}"="${v}"]`);
      else if (values) for (const value of values) out.push(`["${k}"="${value}"]`);
      continue;
    }
    // Règle AND : Overpass n'exprime pas ça en un seul filtre, on approxime
    // par la première condition (les tags secondaires sont de toute façon
    // vérifiés côté client/importeur).
    const first = rule[0]!;
    if (first.v != null) out.push(`["${first.k}"="${first.v}"]`);
  }
  return out;
}
