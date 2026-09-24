/**
 * RedView — dédoublonnage des POI lors de la fusion de sources externes.
 *
 * Le problème : OSM, Overture, AllThePlaces et SIRENE décrivent en partie les
 * mêmes lieux réels. Mesuré sur 20 zones témoin, 47 % des candidats Overture
 * sont déjà dans la base OSM. Une fusion naïve multiplierait les doublons.
 *
 * La solution est un conflate classique en deux temps :
 *
 *   1. **Blocage spatial** — une grille de 200 m. Un candidat n'est comparé
 *      qu'à ses voisins, jamais aux 680 000 POI de la base.
 *   2. **Scoring** — règles ordonnées par force décroissante. Le téléphone et
 *      le domaine web sont des signaux quasi certains ; le nom seul ne suffit
 *      qu'à courte distance.
 *
 * Le nom est normalisé (accents, forme juridique, article) car « Le Petit
 * Restaurant SARL » et « petit restaurant » désignent le même lieu.
 */
import {
  normalizeName, normalizePhone, normalizeDomain, haversine, jaroWinkler,
} from './common.mjs';

/** Grille de blocage, en mètres. 200 m + voisinage 5×5 couvre tout rayon ≤ 300 m. */
const CELL_M = 200;
const NEIGHBOURS = 2; // 5×5

/**
 * Règles d'appariement, évaluées dans l'ordre. La première satisfaite gagne.
 * `d` = distance en mètres, `jw` = similarité de Jaro-Winkler sur les noms.
 */
const RULES = [
  { name: 'phone', test: (a, b, d) => !!a.phone && a.phone === b.phone && d <= 300 },
  { name: 'website', test: (a, b, d) => !!a.domain && a.domain === b.domain && d <= 150 },
  { name: 'name-exact', test: (a, b, d) => !!a.nname && a.nname === b.nname && d <= 80 },
  { name: 'name-strong', test: (a, b, d) => jaroWinkler(a.nname, b.nname) >= 0.90 && d <= 50 },
  { name: 'name-category', test: (a, b, d) => jaroWinkler(a.nname, b.nname) >= 0.80 && a.category === b.category && d <= 30 },
  { name: 'address', test: (a, b, d) => !!a.addr && a.addr === b.addr && d <= 50 },
];

/** Extrait les champs d'appariement d'un enregistrement brut. */
export function toMatchEntry(poi) {
  const tags = poi.tags || {};
  const housenumber = tags['addr:housenumber'] || '';
  const street = tags['addr:street'] || '';
  return {
    id: poi.id,
    lat: poi.lat,
    lon: poi.lon,
    category: poi.category || null,
    nname: normalizeName(poi.name),
    phone: normalizePhone(tags.phone || tags['contact:phone']),
    domain: normalizeDomain(tags.website || tags['contact:website']),
    addr: housenumber && street ? `${normalizeName(housenumber + street)}` : '',
  };
}

export class DedupeIndex {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.cellM]     côté de cellule en mètres
   * @param {boolean} [opts.verbose]   journalise les règles déclenchées
   */
  constructor({ cellM = CELL_M, verbose = false } = {}) {
    this.cellM = cellM;
    this.verbose = verbose;
    /** @type {Map<string, object[]>} */
    this.grid = new Map();
    this.entries = 0;
    this.hits = new Map(); // statistiques par règle
    // Échelle constante en degrés : le pas métrique varie avec la latitude,
    // on prend la référence la plus défavorable (haute latitude) pour que le
    // voisinage 5×5 couvre toujours le rayon de recherche.
    this.degLat = cellM / 110574;
    this.degLon = cellM / (111320 * Math.cos((46.5 * Math.PI) / 180));
  }

  #key(lat, lon) {
    return `${Math.floor(lat / this.degLat)}:${Math.floor(lon / this.degLon)}`;
  }

  get size() {
    return this.entries;
  }

  /** Indexe un POI déjà présent en base. */
  add(poi) {
    this.#insert(toMatchEntry(poi));
  }

  #insert(entry) {
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return;
    const k = this.#key(entry.lat, entry.lon);
    const bucket = this.grid.get(k);
    if (bucket) bucket.push(entry);
    else this.grid.set(k, [entry]);
    this.entries++;
  }

  /**
   * Charge la base existante.
   * @param {import('better-sqlite3').Database} db
   */
  buildFromDb(db, { onProgress } = {}) {
    const rows = db
      .prepare('SELECT id, lat, lon, category, name, tags FROM pois')
      .all();
    let n = 0;
    for (const r of rows) {
      let tags = {};
      if (r.tags) {
        try { tags = JSON.parse(r.tags); } catch { /* tags illisibles : on ignore */ }
      }
      this.add({ ...r, tags });
      if (onProgress && ++n % 100000 === 0) onProgress(n, rows.length);
    }
    return this.entries;
  }

  /**
   * Cherche un doublon d'un candidat externe.
   * @returns {{id:number, rule:string, distance:number, existing:object}|null}
   */
  findMatch(poi) {
    const c = toMatchEntry(poi);
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;

    const cy = Math.floor(c.lat / this.degLat);
    const cx = Math.floor(c.lon / this.degLon);

    for (let dy = -NEIGHBOURS; dy <= NEIGHBOURS; dy++) {
      for (let dx = -NEIGHBOURS; dx <= NEIGHBOURS; dx++) {
        const bucket = this.grid.get(`${cy + dy}:${cx + dx}`);
        if (!bucket) continue;
        for (const e of bucket) {
          // Pré-filtre à 600 m : le voisinage 5×5 peut contenir des points
          // plus lointains que les rayons des règles.
          if (Math.abs(e.lat - c.lat) > 0.0055 || Math.abs(e.lon - c.lon) > 0.0085) continue;
          const d = haversine(c.lat, c.lon, e.lat, e.lon);
          if (d > 300) continue;
          for (const rule of RULES) {
            if (!rule.test(c, e, d)) continue;
            this.hits.set(rule.name, (this.hits.get(rule.name) || 0) + 1);
            return { id: e.id, rule: rule.name, distance: d, existing: e };
          }
        }
      }
    }
    return null;
  }

  /** Ajoute un candidat accepté comme nouveau POI, pour que les suivants le voient. */
  accept(poi) {
    this.#insert(toMatchEntry(poi));
  }

  report() {
    const total = [...this.hits.values()].reduce((a, b) => a + b, 0);
    return [...this.hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([rule, n]) => `   ${String(n).padStart(8)}  ${rule}${total ? ` (${((100 * n) / total).toFixed(0)} %)` : ''}`);
  }
}
