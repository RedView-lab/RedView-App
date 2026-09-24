/**
 * Taux de doublons SIRENE contre OSM **+ Overture**.
 * Mesure pertinente : dans le pipeline, Overture est importee avant SIRENE.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { DedupeIndex } from '../../server/poi-ingest/lib/dedupe.mjs';

const ZONES = {
  'Paris 1-2': [48.860, 2.330, 48.872, 2.350],
  'Paris 11': [48.850, 2.365, 48.862, 2.385],
  "Lyon Presqu'ile": [45.750, 4.820, 45.765, 4.845],
  'Marseille Vieux': [43.288, 5.360, 43.300, 5.380],
  'Bordeaux centre': [44.835, -0.585, 44.848, -0.565],
  'Toulouse centre': [43.595, 1.435, 43.608, 1.455],
  'Nantes centre': [47.208, -1.565, 47.222, -1.545],
  'Lille centre': [50.630, 3.050, 50.642, 3.070],
  'Strasbourg': [48.575, 7.735, 48.588, 7.755],
  'Nice centre': [43.695, 7.260, 43.708, 7.280],
  'Rennes': [48.105, -1.690, 48.118, -1.670],
  'Montpellier': [43.605, 3.870, 43.618, 3.890],
  'Annecy': [45.893, 6.118, 45.905, 6.138],
  'Chamonix': [45.915, 6.855, 45.928, 6.880],
  'Clermont-Fd': [45.772, 3.075, 45.785, 3.095],
  'Rural Aveyron': [44.300, 2.500, 44.340, 2.560],
  'Rural Correze': [45.200, 1.600, 45.240, 1.660],
  'Rural Lozere': [44.500, 3.400, 44.540, 3.460],
  'Alpes Briancon': [44.890, 6.620, 44.910, 6.660],
  'Pyrenees Luchon': [42.680, 0.580, 42.710, 0.620],
};
const NAF2CAT = {
  '56.10A': 'restaurant', '56.10B': 'fast_food', '56.10C': 'fast_food', '56.30Z': 'bar',
  '47.11B': 'convenience', '47.11C': 'supermarket', '47.11D': 'convenience',
  '47.22Z': 'butcher', '47.24Z': 'bakery', '10.71C': 'bakery', '47.30Z': 'fuel',
  '47.64Z': 'outdoor_shop', '47.73Z': 'pharmacy', '53.10Z': 'post_office',
  '55.10Z': 'hotel', '55.90Z': 'hotel', '55.30Z': 'camp_site', '64.19Z': 'atm',
  '86.10Z': 'hospital', '86.21Z': 'doctors', '86.22C': 'doctors', '96.01B': 'laundry',
};
const CATS = [...new Set(Object.values(NAF2CAT))];
const inZone = (lat, lon, z) => lat >= z[0] && lat <= z[2] && lon >= z[1] && lon <= z[3];

// Chargement unique des deux jeux, puis repartition par zone.
const sirene = [];
for await (const line of readline.createInterface({ input: fs.createReadStream('C:/tmp/test/sirene.ndjson'), crlfDelay: Infinity })) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  const cat = NAF2CAT[o.naf];
  if (!cat || !Number.isFinite(o.lat)) continue;
  sirene.push({
    lat: o.lat, lon: o.lon, category: cat,
    name: o.enseigne || o.denomination || null,
    tags: { 'addr:housenumber': o.num, 'addr:street': [o.typevoie, o.voie].filter(Boolean).join(' ') },
  });
}
const overture = [];
for await (const line of readline.createInterface({ input: fs.createReadStream('C:/tmp/test/overture-zones.ndjson'), crlfDelay: Infinity })) {
  if (!line) continue;
  try { overture.push(JSON.parse(line)); } catch { /* ignore */ }
}
console.log(`SIRENE : ${sirene.length.toLocaleString('fr-FR')} | Overture : ${overture.length.toLocaleString('fr-FR')}\n`);

console.log(`${'ZONE'.padEnd(20)}${'OSM'.padStart(6)}${'OVERT'.padStart(7)}${'SIRENE'.padStart(8)}${'DUP'.padStart(7)}${'NEW'.padStart(7)}${'%dup'.padStart(8)}`);
const g = { osm: 0, ov: 0, sir: 0, dup: 0 };
const rules = new Map();
const perCat = new Map();
for (const [name, box] of Object.entries(ZONES)) {
  const url = `http://141.145.220.99/poi/bbox?south=${box[0]}&west=${box[1]}&north=${box[2]}&east=${box[3]}&limit=2000&categories=${CATS.join(',')}`;
  const base = (await (await fetch(url, { signal: AbortSignal.timeout(45000) })).json()).features || [];
  const idx = new DedupeIndex();
  for (const f of base) idx.add(f);
  const ov = overture.filter((o) => inZone(o.lat, o.lon, box));
  for (const o of ov) idx.add(o);
  const sir = sirene.filter((o) => inZone(o.lat, o.lon, box));
  let dup = 0;
  for (const c of sir) {
    const m = idx.findMatch(c);
    if (m) {
      dup++;
      rules.set(m.rule, (rules.get(m.rule) || 0) + 1);
      perCat.set(c.category, (perCat.get(c.category) || 0) + 1);
    }
  }
  console.log(`${name.padEnd(20)}${String(base.length).padStart(6)}${String(ov.length).padStart(7)}${String(sir.length).padStart(8)}${String(dup).padStart(7)}${String(sir.length - dup).padStart(7)}${(sir.length ? (100 * dup / sir.length).toFixed(0) + '%' : '—').padStart(8)}`);
  g.osm += base.length; g.ov += ov.length; g.sir += sir.length; g.dup += dup;
}
console.log('-'.repeat(63));
console.log(`${'TOTAL'.padEnd(20)}${String(g.osm).padStart(6)}${String(g.ov).padStart(7)}${String(g.sir).padStart(8)}${String(g.dup).padStart(7)}${String(g.sir - g.dup).padStart(7)}${(100 * g.dup / g.sir).toFixed(0).padStart(7)}%`);
console.log('\nRegles :');
for (const [r, n] of [...rules.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(6)}  ${r}`);
console.log(`\nProjection SIRENE (797 829 etablissements, dup ${(100 * g.dup / g.sir).toFixed(0)} %) : net ≈ ${Math.round(797829 * (1 - g.dup / g.sir)).toLocaleString('fr-FR')}`);
