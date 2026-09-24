/**
 * RedView — utilitaires partagés des importeurs de sources externes.
 *
 * Ces importeurs complètent la base POI (OSM) avec Overture Maps,
 * AllThePlaces, Foursquare et SIRENE. Ils partagent :
 *   - le chargement de la taxonomie et la résolution tag → catégorie
 *     (même logique que `import-osm.mjs`, pour que les 46 catégories
 *     restent la cible unique — aucune catégorie nouvelle n'est créée) ;
 *   - les normalisations d'appariement (nom, téléphone, domaine web) ;
 *   - l'appel à DuckDB, qui lit les parquet Overture (S3) et SIRENE (HTTP)
 *     **sans les télécharger** grâce à l'élagage de colonnes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Racine du dossier poi-ingest (…/server/poi-ingest). */
export const INGEST_DIR = path.resolve(__dirname, '..');

/** Racine du dépôt (…/redview-app). */
export const REPO_ROOT = path.resolve(INGEST_DIR, '../..');

// ── Taxonomie ─────────────────────────────────────────────────────────

/**
 * Charge la taxonomie. Trois emplacements possibles, dans l'ordre :
 *   1. `--taxonomy <path>` explicite ;
 *   2. `server/poi-ingest/poi-taxonomy.json` — disposition déployée sur le VPS,
 *      où le JSON est copié à côté de l'importeur ;
 *   3. `src/features/poi/poi-taxonomy.json` — source de vérité du dépôt, ce qui
 *      permet de lancer les importeurs en local sans copie préalable.
 */
export function loadTaxonomy(explicitPath) {
  const candidates = [
    explicitPath,
    path.resolve(INGEST_DIR, 'poi-taxonomy.json'),
    path.resolve(REPO_ROOT, 'src/features/poi/poi-taxonomy.json'),
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    console.error(`❌ Taxonomie introuvable. Chemins essayés :\n   ${candidates.join('\n   ')}`);
    process.exit(1);
  }
  const taxonomy = JSON.parse(fs.readFileSync(found, 'utf8'));
  return { taxonomy, path: found, keepTags: new Set(taxonomy.keepTags || []) };
}

function condMatches(tags, cond) {
  const v = tags[cond.k];
  if (v == null) return false;
  if (cond.v != null) return v === cond.v;
  if (Array.isArray(cond.in)) return cond.in.includes(v);
  return false;
}

/** Retourne la clé de catégorie RedView, ou null. Même logique que import-osm.mjs. */
export function makeResolveCategory(taxonomy) {
  return function resolveCategory(tags) {
    if (!tags) return null;
    for (const cat of taxonomy.categories) {
      for (const rule of cat.rules) {
        let ok = true;
        for (const cond of rule) {
          if (!condMatches(tags, cond)) { ok = false; break; }
        }
        if (ok) return cat.key;
      }
    }
    return null;
  };
}

export function makeBuildTagsJson(keepTags) {
  return function buildTagsJson(tags) {
    const kept = {};
    for (const [k, v] of Object.entries(tags)) {
      // Les sources externes produisent beaucoup de champs nuls : les écrire
      // gonflerait chaque ligne pour rien.
      if (v == null || v === '') continue;
      if (k === 'name' || k === 'name:fr') { kept[k] = v; continue; }
      if (!keepTags.has(k)) continue;
      kept[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v;
    }
    return JSON.stringify(kept);
  };
}

export function buildName(tags) {
  return tags.name || tags['name:fr'] || tags['name:en'] || tags.alt_name || tags.brand || tags.operator || null;
}

// ── Normalisations d'appariement ──────────────────────────────────────

const LEGAL_FORMS = /\b(sarl|sas|sasu|sa|eurl|snc|sci|scp|scop|gie|ets|etablissements?|ste|societe|restaurant|hotel|chez|le|la|les|l|du|de|des|d)\b/g;

/** Nom comparable : minuscules, sans accents, sans forme juridique ni article. */
export function normalizeName(s) {
  if (!s) return '';
  const stripped = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return stripped.replace(LEGAL_FORMS, ' ').replace(/[^a-z0-9]/g, '');
}

/** Téléphone comparable : chiffres seuls, indicatif 33 ramené à 0. */
export function normalizePhone(s) {
  if (!s) return '';
  let d = String(s).replace(/\D/g, '');
  if (d.startsWith('0033')) d = '0' + d.slice(4);
  else if (d.startsWith('33') && d.length >= 11) d = '0' + d.slice(2);
  return d.length >= 9 ? d : '';
}

/** Domaine comparable d'une URL. */
export function normalizeDomain(s) {
  if (!s) return '';
  const m = /^https?:\/\/([^/]+)/i.exec(s) || /^([a-z0-9.-]+\.[a-z]{2,})/i.exec(s);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/** Distance en mètres entre deux points WGS84. */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Similarité de Jaro-Winkler (0-1). Suffisante pour des noms de lieux courts. */
export function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - maxDist);
    const hi = Math.min(i + maxDist + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// ── DuckDB ────────────────────────────────────────────────────────────

/**
 * Localise le binaire DuckDB. Aucune dépendance npm : le CLI est un binaire
 * statique unique, ce qui évite d'ajouter un moteur analytique au serveur.
 *
 * Ordre : --duckdb / DUCKDB_BIN → bin/duckdb du dépôt → PATH.
 */
export function resolveDuckDb(explicit) {
  const candidates = [
    explicit,
    process.env.DUCKDB_BIN,
    path.resolve(INGEST_DIR, 'bin/duckdb'),
    path.resolve(INGEST_DIR, 'bin/duckdb.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const probe = spawnSync('duckdb', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'duckdb';
  return null;
}

export const DUCKDB_INSTALL_HINT = [
  '❌ DuckDB introuvable. Les sources externes sont distribuées en Parquet :',
  '   DuckDB les lit à distance (S3 / HTTP) sans téléchargement, c\'est ce qui',
  '   rend l\'ingestion possible sans 20 Go de disque.',
  '',
  '   Installation (binaire statique, ~40 Mo) :',
  '     curl -Ls https://install.duckdb.org | sh',
  '     # ou : wget https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip',
  '',
  '   Puis relancer. Chemin explicite possible via --duckdb <chemin> ou DUCKDB_BIN.',
].join('\n');

/** Exécute une requête DuckDB. `quiet` laisse la barre de progression visible. */
export function runDuckDb(sql, { duckdb, quiet = false } = {}) {
  const exe = resolveDuckDb(duckdb);
  if (!exe) {
    console.error(DUCKDB_INSTALL_HINT);
    process.exit(1);
  }
  const res = spawnSync(exe, ['-c', sql], {
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    console.error(`\n❌ DuckDB a échoué (code ${res.status}).`);
    process.exit(1);
  }
}

/** Dernière release Overture, lue sur le catalogue STAC (jamais codée en dur). */
export async function latestOvertureRelease() {
  const res = await fetch('https://stac.overturemaps.org/catalog.json', { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`STAC Overture : HTTP ${res.status}`);
  const cat = await res.json();
  if (!cat.latest) throw new Error('STAC Overture : champ "latest" absent');
  return cat.latest;
}

// ── Schéma ────────────────────────────────────────────────────────────

/**
 * Ajoute `source` et `src_confidence` à `pois` si absentes.
 *
 * Idempotent : relancer ne fait rien. Le serveur détecte déjà la présence de
 * colonnes (`HAS_OSM_TYPE`) et reste compatible avec une base ancienne, donc
 * cette migration ne casse pas un rollback.
 */
export function ensureExternalSchema(db) {
  const cols = new Set(
    db.prepare("SELECT name FROM pragma_table_info('pois')").all().map((r) => r.name),
  );
  const added = [];
  if (!cols.has('source')) { db.exec('ALTER TABLE pois ADD COLUMN source TEXT'); added.push('source'); }
  if (!cols.has('src_confidence')) { db.exec('ALTER TABLE pois ADD COLUMN src_confidence REAL'); added.push('src_confidence'); }
  if (added.length) db.exec('CREATE INDEX IF NOT EXISTS idx_pois_source ON pois(source)');
  return added;
}

/**
 * Bases d'identifiants des sources externes.
 *
 * Le schéma OSM occupe déjà : node = osm_id, way = 1e13 + id,
 * relation = 2e13 + id. On prolonge la même convention pour rester
 * collision-free, et on borne les hachages à 42 bits pour ne jamais
 * déborder sur la plage suivante.
 */
export const ID_BASE = {
  overture: 30_000_000_000_000, // 3e13
  atp: 40_000_000_000_000,      // 4e13
  fsq: 50_000_000_000_000,      // 5e13
  sirene: 60_000_000_000_000,   // 6e13
};

const HASH_MOD = 4_398_046_511_104n; // 2^42

/** Hachage stable 42 bits d'une chaîne — ids reproductibles d'un run à l'autre. */
export function hash42(str) {
  let h = 2166136261n;
  const P = 16777619n;
  const M = 4294967296n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * P) % M;
  }
  return Number(h % HASH_MOD);
}

// ── CLI ───────────────────────────────────────────────────────────────

/** Parseur d'arguments minimal, cohérent avec les scripts existants. */
export function parseArgs(argv, spec) {
  const out = {};
  for (const [flag, key] of Object.entries(spec)) {
    out[key] = undefined;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = spec[a];
    if (key === undefined) {
      if (a === '--help' || a === '-h') out.help = true;
      continue;
    }
    if (key === 'boolean') { out[a.replace(/^--/, '').replace(/-/g, '_')] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

export function openTargetDb(dbPath, { readonly = false } = {}) {
  const p = path.resolve(dbPath);
  if (!readonly && !fs.existsSync(p)) {
    console.error(`❌ Base introuvable : ${p}`);
    process.exit(1);
  }
  return p;
}

/**
 * Résout une dépendance depuis l'installation du serveur POI.
 *
 * `better-sqlite3` est déclaré dans `server/poi-server/package.json`, pas à la
 * racine du dépôt. Or `poi-server/` n'est **pas** un dossier ancêtre de
 * `poi-ingest/` : la résolution ESM standard ne le trouverait jamais. On
 * l'indique donc explicitement.
 *
 * Deux dispositions fonctionnent avec ce code :
 *   - dépôt : `<racine>/server/poi-ingest/` → `../poi-server/node_modules`
 *   - déploiement à plat sur le VPS : tout est dans `/opt/poi-server/`, donc
 *     `../poi-server` désigne le dossier courant.
 */
export function requireFromServer(pkg) {
  const candidates = [
    path.resolve(INGEST_DIR, '../poi-server/package.json'), // disposition dépôt
    path.resolve(INGEST_DIR, 'package.json'),               // déploiement à plat
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      return createRequire(c)(pkg);
    } catch { /* on essaie le suivant */ }
  }
  return createRequire(import.meta.url)(pkg);
}
