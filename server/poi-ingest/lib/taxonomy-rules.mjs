/**
 * RedView — règles de la taxonomie POI (tag OSM → catégorie), sans dépendance.
 *
 * Une seule implémentation pour tous les importeurs (`import-osm.mjs`,
 * `import-relations.mjs`, sources externes via `common.mjs`) : avant elle,
 * chaque importeur recopiait son propre `condMatches`, et une nouvelle forme
 * de condition n'aurait été comprise que par certains d'entre eux.
 *
 * Une règle est un AND de conditions ; une catégorie est un OR de règles ;
 * la première catégorie qui correspond gagne. Une condition vaut :
 *   - `{ k, v }`        le tag `k` vaut exactement `v` ;
 *   - `{ k, in: [...] }` le tag `k` vaut l'une des valeurs ;
 *   - `{ k, notIn: [...] }` le tag `k` est absent ou ne vaut aucune des
 *     valeurs (exclusion : `landuse=cemetery` sans `cemetery=grave|sector`,
 *     qui décrivent une tombe ou un carré à l'intérieur d'un cimetière).
 */

/** Vrai si `tags` satisfait la condition. */
export function condMatches(tags, cond) {
  const v = tags[cond.k];
  if (Array.isArray(cond.notIn)) return v == null || !cond.notIn.includes(v);
  if (v == null) return false;
  if (cond.v != null) return v === cond.v;
  if (Array.isArray(cond.in)) return cond.in.includes(v);
  return false;
}

/** Vrai si `tags` satisfait toutes les conditions de la règle. */
export function ruleMatches(tags, rule) {
  for (const cond of rule) {
    if (!condMatches(tags, cond)) return false;
  }
  return true;
}

/**
 * Résolveur tag → clé de catégorie (ou null).
 *
 * `only` restreint la *sortie* à certaines catégories sans changer la
 * priorité : un objet est toujours classé par la taxonomie complète, puis
 * gardé seulement si sa catégorie est demandée. C'est ce qui permet d'ajouter
 * une catégorie à une base existante (`import-osm.mjs --categories`) avec
 * exactement le résultat qu'une reconstruction complète donnerait.
 *
 * @param {{ categories: Array<{ key: string, rules: object[][] }> }} taxonomy
 * @param {Iterable<string>|null} [only]
 */
export function makeResolveCategory(taxonomy, only = null) {
  const keep = only ? new Set(only) : null;
  return function resolveCategory(tags) {
    if (!tags) return null;
    for (const cat of taxonomy.categories) {
      for (const rule of cat.rules) {
        if (ruleMatches(tags, rule)) return keep && !keep.has(cat.key) ? null : cat.key;
      }
    }
    return null;
  };
}

/** Valide une liste `--categories` contre la taxonomie ; lève sur une clé inconnue. */
export function parseCategoryList(taxonomy, csv) {
  if (!csv) return null;
  const known = new Set(taxonomy.categories.map((c) => c.key));
  const list = String(csv).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`Catégorie(s) inconnue(s) de la taxonomie : ${unknown.join(', ')}`);
  return list.length ? list : null;
}

function overpassString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function overpassRegexAlternation(values) {
  return `^(${values.map((v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

/**
 * Traduit une règle en filtres de tags Overpass QL (`["k"="v"]["k2"!~"…"]`),
 * ou null si la règle n'a aucune condition positive (une requête Overpass
 * faite uniquement d'exclusions balaierait toute la boîte).
 */
export function ruleToOverpassFilter(rule) {
  let positive = 0;
  const parts = [];
  for (const cond of rule) {
    const k = overpassString(cond.k);
    if (Array.isArray(cond.notIn)) {
      if (cond.notIn.length) parts.push(`["${k}"!~"${overpassString(overpassRegexAlternation(cond.notIn))}"]`);
      continue;
    }
    if (cond.v != null) parts.push(`["${k}"="${overpassString(cond.v)}"]`);
    else if (Array.isArray(cond.in) && cond.in.length) parts.push(`["${k}"~"${overpassString(overpassRegexAlternation(cond.in))}"]`);
    else return null;
    positive++;
  }
  return positive > 0 ? parts.join('') : null;
}
