/**
 * RedView — audit de complétude de la base POI (serveur `redview-poi-server`).
 *
 * Compare, pour plusieurs zones témoin, ce que la base RedView renvoie avec la
 * vérité terrain OpenStreetMap :
 *
 *   1. référence France entière via l'instance taginfo régionale France
 *      (https://taginfo.openstreetmap.fr — base « data only for France »),
 *      avec le découpage nodes / ways / relations ;
 *   2. comptage local par zone via Overpass `out count` (nwr, puis node seul
 *      pour mesurer la part des POI cartographiés en bâtiment) ;
 *   3. comptage base RedView via `/bbox` par catégorie.
 *
 * Usage :
 *   node script-test-bench/audit-poi-db.mjs                # audit complet
 *   node script-test-bench/audit-poi-db.mjs --quick        # 3 zones
 *   node script-test-bench/audit-poi-db.mjs --no-overpass  # taginfo seul
 *
 * Sortie : rapport markdown dans script-test-bench/reports/ + JSON brut.
 */
import fs from 'node:fs';
import path from 'node:path';

const POI_BASE = process.env.POI_UPSTREAM || 'http://141.145.220.99/poi';
const TAGINFO = 'https://taginfo.openstreetmap.fr/api/4';
const UA = 'RedView-POI-audit/1.0 (+https://redview.tech)';

const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const QUICK = process.argv.includes('--quick');
const NO_OVERPASS = process.argv.includes('--no-overpass');
const USE_TAXONOMY = process.argv.includes('--taxonomy');

// ── Catégories actuellement servies par la base (mesurées via /categories) ──
// `filters` = union de tags OSM censée alimenter la catégorie.
const LEGACY_CATEGORIES = [
  { key: 'drinking_water', filters: [['amenity', 'drinking_water']] },
  { key: 'restaurant', filters: [['amenity', 'restaurant']] },
  { key: 'shelter', filters: [['tourism', 'wilderness_hut'], ['shelter_type', 'basic_hut'], ['shelter_type', 'weather_shelter']] },
  { key: 'toilets', filters: [['amenity', 'toilets']] },
  { key: 'fast_food', filters: [['amenity', 'fast_food']] },
  { key: 'bakery', filters: [['shop', 'bakery']] },
  { key: 'hotel', filters: [['tourism', 'hotel'], ['tourism', 'hostel'], ['tourism', 'guest_house'], ['tourism', 'chalet']] },
  { key: 'convenience', filters: [['shop', 'convenience']] },
  { key: 'bar', filters: [['amenity', 'bar']] },
  { key: 'pharmacy', filters: [['amenity', 'pharmacy']] },
  { key: 'cafe', filters: [['amenity', 'cafe']] },
  { key: 'supermarket', filters: [['shop', 'supermarket']] },
  { key: 'fuel', filters: [['amenity', 'fuel']] },
  { key: 'bicycle_repair', filters: [['amenity', 'bicycle_repair_station'], ['service:bicycle:repair', 'yes']] },
  { key: 'alpine_hut', filters: [['tourism', 'alpine_hut']] },
  { key: 'bicycle', filters: [['shop', 'bicycle']] },
  { key: 'camp_site', filters: [['tourism', 'camp_site']] },
  { key: 'hospital', filters: [['amenity', 'hospital']] },
];

/**
 * En mode `--taxonomy`, on mesure la NOUVELLE taxonomie (46 catégories) au
 * lieu des 18 historiques : les filtres Overpass sont dérivés des règles du
 * fichier `src/features/poi/poi-taxonomy.json`.
 *
 * Approximation assumée : pour les règles AND (ex. distributeur), seule la
 * première condition est utilisée côté Overpass, donc la « vérité » OSM est
 * surestimée pour ces rares catégories.
 */
function loadTaxonomyCategories() {
  const raw = JSON.parse(fs.readFileSync('src/features/poi/poi-taxonomy.json', 'utf8'));
  const out = [];
  for (const cat of raw.categories) {
    const filters = [];
    for (const rule of cat.rules) {
      const first = rule[0];
      if (first.v != null) filters.push([first.k, first.v]);
      else if (Array.isArray(first.in)) for (const v of first.in) filters.push([first.k, v]);
    }
    out.push({ key: cat.key, filters });
  }
  return out;
}

const CATEGORIES = USE_TAXONOMY ? loadTaxonomyCategories() : LEGACY_CATEGORIES;

// Zones témoin : couvrent les régions Geofabrik réellement ingérées ET celles
// qui manquent au script d'ingestion (Rhône-Alpes, Île-de-France, Nord,
// Champagne-Ardenne, Normandie) + le cas Corse signalé par l'utilisateur.
const AREAS = [
  { name: 'Corse — Palasca (cas signalé)', south: 42.630, west: 9.070, north: 42.660, east: 9.110 },
  { name: 'Alpes — Chamonix (Rhône-Alpes)', south: 45.900, west: 6.850, north: 45.950, east: 6.950 },
  { name: 'Alpes — Lyon centre (Rhône-Alpes)', south: 45.740, west: 4.820, north: 45.780, east: 4.880 },
  { name: 'Île-de-France — Paris centre', south: 48.850, west: 2.330, north: 48.870, east: 2.370 },
  { name: 'Hauts-de-France — Lille', south: 50.620, west: 3.040, north: 50.650, east: 3.080 },
  { name: 'Grand Est — Reims (Champagne)', south: 49.240, west: 4.020, north: 49.270, east: 4.060 },
  { name: 'Bretagne — Brest (région ingérée)', south: 48.380, west: -4.500, north: 48.400, east: -4.470 },
  { name: 'Occitanie — Toulouse (région ingérée)', south: 43.590, west: 1.430, north: 43.620, east: 1.460 },
];

const QUICK_AREAS = new Set([0, 1, 3]);

// ── Helpers réseau ────────────────────────────────────────────────────

async function fetchJson(url, { timeout = 30000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function overpass(ql, { attempts = 4 } = {}) {
  let lastErr = 'unknown';
  for (let a = 0; a < attempts; a++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            Accept: 'application/json',
            'User-Agent': UA,
          },
          body: ql,
          signal: AbortSignal.timeout(180000),
        });
        if (res.status === 429 || res.status === 504 || res.status === 502) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        const data = await res.json();
        // Overpass renvoie un `remark` (et des elements vides) quand la
        // requête échoue ou expire : sans ce garde-fou on comptait 0 POI et
        // on concluait à tort que la base était complète.
        if (data?.remark && /error|timed?\s?out|rate_limited|load/i.test(String(data.remark))) {
          lastErr = `remark: ${String(data.remark).slice(0, 80)}`;
          continue;
        }
        return data;
      } catch (err) {
        lastErr = err.message;
      }
    }
    await sleep(3000);
  }
  throw new Error(`Overpass unavailable (${lastErr})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Référence France entière (taginfo régional) ────────────────────

async function taginfoCount(key, value) {
  const data = await fetchJson(
    `${TAGINFO}/tag/stats?key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`,
    { timeout: 25000 },
  );
  const rows = data.data || [];
  const pick = (t) => rows.find((r) => r.type === t)?.count ?? 0;
  return { all: pick('all'), nodes: pick('nodes'), ways: pick('ways'), relations: pick('relations') };
}

async function buildFranceReference() {
  const out = {};
  for (const cat of CATEGORIES) {
    const agg = { all: 0, nodes: 0, ways: 0, relations: 0, tags: {} };
    for (const [k, v] of cat.filters) {
      try {
        const c = await taginfoCount(k, v);
        agg.tags[`${k}=${v}`] = c;
        agg.all += c.all;
        agg.nodes += c.nodes;
        agg.ways += c.ways;
        agg.relations += c.relations;
      } catch (err) {
        agg.tags[`${k}=${v}`] = { error: err.message };
      }
      await sleep(120);
    }
    out[cat.key] = agg;
  }
  return out;
}

// ── 2. Vérité locale Overpass ─────────────────────────────────────────

function qlCount(area, mode, category) {
  const bbox = `(${area.south},${area.west},${area.north},${area.east})`;
  const blocks = category.filters
    .map(([k, v]) => `${mode}["${k}"="${v}"]${bbox};`)
    .join('\n  ');
  return `[out:json][timeout:170];\n(\n  ${blocks}\n);\nout count;`;
}

function qlCountAll(area, mode) {
  const bbox = `(${area.south},${area.west},${area.north},${area.east})`;
  const parts = [];
  for (const cat of CATEGORIES) {
    const blocks = cat.filters.map(([k, v]) => `${mode}["${k}"="${v}"]${bbox};`).join('\n    ');
    parts.push(`(\n    ${blocks}\n  );\n  out count;`);
  }
  return `[out:json][timeout:170];\n${parts.join('\n')}`;
}

function parseCounts(elements) {
  return (elements || [])
    .filter((e) => e.type === 'count')
    .map((e) => Number(e.tags?.total ?? 0));
}

async function overpassAreaCounts(area, mode) {
  const data = await overpass(qlCountAll(area, mode));
  const counts = parseCounts(data.elements);
  if (counts.length !== CATEGORIES.length) {
    // Fallback : une requête par catégorie si l'ordre agrégé n'est pas garanti.
    const res = {};
    for (const cat of CATEGORIES) {
      try {
        const one = await overpass(qlCount(area, mode, cat));
        res[cat.key] = parseCounts(one.elements)[0] ?? 0;
      } catch {
        res[cat.key] = null;
      }
      await sleep(1200);
    }
    return res;
  }
  const res = {};
  CATEGORIES.forEach((cat, i) => { res[cat.key] = counts[i]; });
  return res;
}

// ── 3. Base RedView ───────────────────────────────────────────────────

async function dbAreaCounts(area) {
  const res = {};
  for (const cat of CATEGORIES) {
    const url = `${POI_BASE}/bbox?south=${area.south}&west=${area.west}&north=${area.north}&east=${area.east}`
      + `&categories=${cat.key}&limit=2000`;
    try {
      const data = await fetchJson(url, { timeout: 25000 });
      const n = data.features?.length ?? 0;
      res[cat.key] = n >= 2000 ? 2000 : n;
      if (n >= 2000) res[`${cat.key}__capped`] = true;
    } catch (err) {
      res[cat.key] = null;
      res[`${cat.key}__error`] = err.message;
    }
  }
  return res;
}

// ── Rapport ───────────────────────────────────────────────────────────

const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)} %` : '—');

function buildReport({ health, categories, france, areas, overpassSplits }) {
  const L = [];
  const dbByCat = Object.fromEntries((categories || []).map((c) => [c.category, c.count]));

  L.push('# RedView — audit de complétude de la base POI');
  L.push('');
  L.push(`Généré le ${new Date().toISOString()}`);
  L.push('');
  L.push(`- Serveur interrogé : \`${POI_BASE}\``);
  L.push(`- POI indexés : **${health.total_pois.toLocaleString('fr-FR')}**`);
  L.push(`- Catégories servies : **${(categories || []).length}**`);
  L.push('');

  L.push('## 1. Référence France entière (taginfo régional France) vs base RedView');
  L.push('');
  L.push('| Catégorie | OSM France (total) | dont nodes | dont ways | dont relations | Base RedView | Couverture |');
  L.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const totalOsm = { all: 0, nodes: 0, ways: 0, relations: 0 };
  const totalDb = { v: 0 };
  for (const cat of CATEGORIES) {
    const f = france[cat.key] || { all: 0, nodes: 0, ways: 0, relations: 0 };
    const db = dbByCat[cat.key] ?? 0;
    totalOsm.all += f.all; totalOsm.nodes += f.nodes; totalOsm.ways += f.ways; totalOsm.relations += f.relations;
    totalDb.v += db;
    L.push(`| \`${cat.key}\` | ${f.all.toLocaleString('fr-FR')} | ${f.nodes.toLocaleString('fr-FR')} | ${f.ways.toLocaleString('fr-FR')} | ${f.relations.toLocaleString('fr-FR')} | ${db.toLocaleString('fr-FR')} | ${pct(db, f.all)} |`);
  }
  L.push(`| **TOTAL** | **${totalOsm.all.toLocaleString('fr-FR')}** | **${totalOsm.nodes.toLocaleString('fr-FR')}** | **${totalOsm.ways.toLocaleString('fr-FR')}** | **${totalOsm.relations.toLocaleString('fr-FR')}** | **${totalDb.v.toLocaleString('fr-FR')}** | **${pct(totalDb.v, totalOsm.all)}** |`);
  L.push('');
  L.push('> Les compteurs base incluent des POI **hors France** (voir §3), la couverture réelle en France est donc encore plus faible.');
  L.push('');

  L.push('## 2. Couverture par zone témoin (vérité Overpass `nwr`)');
  L.push('');
  for (const area of areas) {
    const op = area.overpass || {};
    const db = area.db || {};
    L.push(`### ${area.name}`);
    L.push(`\`${area.south},${area.west},${area.north},${area.east}\``);
    L.push('');
    const usable = CATEGORIES.filter((cat) => op[cat.key] != null && db[cat.key] != null);
    if (usable.length === 0) {
      L.push('> Vérité Overpass indisponible pour cette zone (endpoints saturés) — seuls les compteurs base sont exploitables.');
      L.push('');
      const dbOnly = CATEGORIES.filter((cat) => (db[cat.key] ?? 0) > 0);
      if (dbOnly.length === 0) {
        L.push('Aucun POI renvoyé par la base dans cette zone.');
        L.push('');
        continue;
      }
      L.push('| Catégorie | Base RedView |');
      L.push('| --- | ---: |');
      for (const cat of dbOnly) L.push(`| \`${cat.key}\` | ${db[cat.key]} |`);
      L.push('');
      continue;
    }
    L.push('| Catégorie | OSM (nwr) | Base RedView | Couverture |');
    L.push('| --- | ---: | ---: | ---: |');
    let sumOp = 0; let sumDb = 0;
    for (const cat of usable) {
      const o = op[cat.key];
      const d = db[cat.key];
      if (o === 0 && d === 0) continue;
      sumOp += o; sumDb += d;
      L.push(`| \`${cat.key}\` | ${o} | ${d}${db[`${cat.key}__capped`] ? ' (plafonné)' : ''} | ${pct(d, o)} |`);
    }
    L.push(`| **TOTAL** | **${sumOp}** | **${sumDb}** | **${pct(sumDb, sumOp)}** |`);
    L.push('');
  }

  if (overpassSplits?.length) {
    L.push('## 3. Cause racine — POI cartographiés en bâtiment (way) jamais indexés');
    L.push('');
    L.push('| Zone | POI en node | POI en way/relation | Part non indexable par l\'ingestion actuelle |');
    L.push('| --- | ---: | ---: | ---: |');
    for (const s of overpassSplits) {
      L.push(`| ${s.name} | ${s.nodeTotal} | ${s.nwrTotal - s.nodeTotal} | ${pct(s.nwrTotal - s.nodeTotal, s.nwrTotal)} |`);
    }
    L.push('');
  }

  L.push('## 4. Données hors France présentes dans la base');
  L.push('');
  L.push('| Sonde | POI renvoyés par la base |');
  L.push('| --- | --- |');
  for (const p of (areas[0]?.foreignProbes || [])) {
    L.push(`| ${p.name} | ${JSON.stringify(p.byCategory)} |`);
  }
  L.push('');
  return L.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  const health = await fetchJson(`${POI_BASE}/health`);
  const catData = await fetchJson(`${POI_BASE}/categories`);
  const categories = catData.categories || [];
  console.log(`\n📊 Base : ${health.total_pois} POI, ${categories.length} catégories.\n`);

  console.log('🔎 Référence France entière (taginfo régional France)...');
  const france = await buildFranceReference();
  for (const cat of CATEGORIES) {
    const f = france[cat.key];
    console.log(`   ${cat.key.padEnd(16)} OSM=${String(f.all).padStart(8)}  (nodes ${f.nodes} / ways ${f.ways} / rel ${f.relations})`);
  }

  const selectedAreas = QUICK ? AREAS.filter((_, i) => QUICK_AREAS.has(i)) : AREAS;
  const results = [];

  for (const area of selectedAreas) {
    console.log(`\n📍 ${area.name}`);
    const db = await dbAreaCounts(area);
    const dbTotal = Object.entries(db).filter(([k]) => !k.includes('__')).reduce((a, [, v]) => a + (v || 0), 0);
    console.log(`   base RedView : ${dbTotal} POI`);

    let op = null;
    if (!NO_OVERPASS) {
      try {
        op = await overpassAreaCounts(area, 'nwr');
        const opTotal = Object.values(op).reduce((a, v) => a + (v || 0), 0);
        console.log(`   OSM nwr      : ${opTotal} POI`);
      } catch (err) {
        console.log(`   OSM nwr      : indisponible (${err.message})`);
      }
    }
    results.push({ ...area, db, overpass: op });
    await sleep(1500);
  }

  const overpassSplits = [];
  if (!NO_OVERPASS) {
    for (const area of results.slice(0, 3)) {
      try {
        const nwrTotal = Object.values(area.overpass || {}).reduce((a, v) => a + (v || 0), 0);
        if (!nwrTotal) continue;
        const nodeCounts = await overpassAreaCounts(area, 'node');
        const nodeTotal = Object.values(nodeCounts).reduce((a, v) => a + (v || 0), 0);
        overpassSplits.push({ name: area.name, nwrTotal, nodeTotal });
        console.log(`   split ${area.name}: node=${nodeTotal} nwr=${nwrTotal}`);
      } catch (err) {
        console.log(`   split indisponible (${err.message})`);
      }
      await sleep(1500);
    }
  }

  const foreignProbes = [];
  const probes = [
    ['Milan (IT)', 45.45, 9.17, 45.48, 9.21],
    ['Genève (CH)', 46.19, 6.13, 46.21, 6.16],
    ['Barcelone (ES)', 41.37, 2.15, 41.40, 2.18],
    ['Bruxelles (BE)', 50.84, 4.34, 50.86, 4.37],
  ];
  for (const [name, s, w, n, e] of probes) {
    try {
      const d = await fetchJson(`${POI_BASE}/bbox?south=${s}&west=${w}&north=${n}&east=${e}&limit=2000`);
      const byCategory = {};
      for (const f of (d.features || [])) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
      foreignProbes.push({ name, byCategory });
    } catch { /* ignore */ }
  }

  if (results.length) results[0].foreignProbes = foreignProbes;

  const report = buildReport({ health, categories, france, areas: results, overpassSplits });
  const outDir = path.resolve('script-test-bench/reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'poi-db-audit.md'), report, 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'poi-db-audit.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), health, categories, france, areas: results, overpassSplits, foreignProbes }, null, 2),
    'utf8',
  );

  console.log(`\n✅ Rapport écrit : script-test-bench/reports/poi-db-audit.md (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
