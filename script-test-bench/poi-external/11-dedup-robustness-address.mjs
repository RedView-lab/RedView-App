import fs from 'node:fs';
import readline from 'node:readline';
import { DedupeIndex } from '../../server/poi-ingest/lib/dedupe.mjs';
import { normalizeName } from '../../server/poi-ingest/lib/common.mjs';

const ZONES = {
  'Paris 1-2': [48.860, 2.330, 48.872, 2.350], 'Paris 11': [48.850, 2.365, 48.862, 2.385],
  "Lyon Presqu'ile": [45.750, 4.820, 45.765, 4.845], 'Bordeaux centre': [44.835, -0.585, 44.848, -0.565],
  'Toulouse centre': [43.595, 1.435, 43.608, 1.455], 'Nantes centre': [47.208, -1.565, 47.222, -1.545],
  'Strasbourg': [48.575, 7.735, 48.588, 7.755], 'Nice centre': [43.695, 7.260, 43.708, 7.280],
  'Rennes': [48.105, -1.690, 48.118, -1.670], 'Annecy': [45.893, 6.118, 45.905, 6.138],
  'Clermont-Fd': [45.772, 3.075, 45.785, 3.095], 'Marseille Vieux': [43.288, 5.360, 43.300, 5.380],
  'Lille centre': [50.630, 3.050, 50.642, 3.070], 'Montpellier': [43.605, 3.870, 43.618, 3.890],
  'Chamonix': [45.915, 6.855, 45.928, 6.880],
};
const NAF2CAT = {
  '56.10A': 'restaurant', '56.10C': 'fast_food', '56.30Z': 'bar', '47.11B': 'convenience',
  '47.24Z': 'bakery', '10.71C': 'bakery', '47.73Z': 'pharmacy', '55.10Z': 'hotel',
  '86.21Z': 'doctors', '86.22C': 'doctors', '64.19Z': 'atm', '96.01B': 'laundry',
  '47.22Z': 'butcher', '47.64Z': 'outdoor_shop', '47.30Z': 'fuel', '55.30Z': 'camp_site',
  '53.10Z': 'post_office',
};
const CATS = [...new Set(Object.values(NAF2CAT))];
const inZ = (a, b, z) => a >= z[0] && a <= z[2] && b >= z[1] && b <= z[3];

const sir = [];
for await (const l of readline.createInterface({ input: fs.createReadStream('C:/tmp/test/sirene.ndjson'), crlfDelay: Infinity })) {
  if (!l) continue;
  let o; try { o = JSON.parse(l); } catch { continue; }
  const c = NAF2CAT[o.naf];
  if (!c || !Number.isFinite(o.lat)) continue;
  sir.push({
    lat: o.lat, lon: o.lon, category: c, name: o.enseigne || o.denomination || null,
    tags: { 'addr:housenumber': o.num, 'addr:street': [o.typevoie, o.voie].filter(Boolean).join(' ') },
  });
}
const ov = [];
for await (const l of readline.createInterface({ input: fs.createReadStream('C:/tmp/test/overture-zones.ndjson'), crlfDelay: Infinity })) {
  if (!l) continue;
  try { ov.push(JSON.parse(l)); } catch { /* ignore */ }
}

let tot = 0, dupN = 0, newN = 0, addrInOsm = 0, addrInOv = 0;
const catNew = new Map();
for (const [name, box] of Object.entries(ZONES)) {
  const url = 'http://141.145.220.99/poi/bbox?south=' + box[0] + '&west=' + box[1]
    + '&north=' + box[2] + '&east=' + box[3] + '&limit=2000&categories=' + CATS.join(',');
  const base = (await (await fetch(url, { signal: AbortSignal.timeout(45000) })).json()).features || [];
  const idx = new DedupeIndex();
  for (const f of base) idx.add(f);
  const ovz = ov.filter((o) => inZ(o.lat, o.lon, box));
  for (const o of ovz) idx.add(o);

  const aOsm = new Set(); const aOv = new Set();
  for (const f of base) {
    const t = f.tags || {};
    if (t['addr:housenumber'] && t['addr:street']) aOsm.add(normalizeName(t['addr:housenumber'] + ' ' + t['addr:street']));
  }
  for (const o of ovz) {
    const t = o.tags || {};
    if (t['addr:housenumber'] && t['addr:street']) aOv.add(normalizeName(t['addr:housenumber'] + ' ' + t['addr:street']));
  }

  for (const c of sir.filter((o) => inZ(o.lat, o.lon, box))) {
    tot++;
    if (idx.findMatch(c)) { dupN++; continue; }
    newN++;
    const t = c.tags || {};
    const key = (t['addr:housenumber'] && t['addr:street'])
      ? normalizeName(t['addr:housenumber'] + ' ' + t['addr:street']) : '';
    if (!key) continue;
    if (aOsm.has(key)) { addrInOsm++; catNew.set(c.category, (catNew.get(c.category) || 0) + 1); }
    else if (aOv.has(key)) { addrInOv++; catNew.set(c.category, (catNew.get(c.category) || 0) + 1); }
  }
}
const addrOnly = addrInOsm + addrInOv;
console.log('SIRENE analyses             : ' + tot);
console.log('doublons (nom/adresse)      : ' + dupN + ' (' + (100 * dupN / tot).toFixed(0) + ' %)');
console.log('"nouveaux"                  : ' + newN);
console.log('  dont meme adresse qu un POI OSM      : ' + addrInOsm);
console.log('  dont meme adresse qu un POI Overture : ' + addrInOv);
console.log('  -> doublons probables non detectes   : ' + addrOnly + ' (' + (100 * addrOnly / newN).toFixed(0) + ' % des "nouveaux")');
console.log('');
console.log('Taux de doublons SIRENE estime : ' + (100 * (dupN + addrOnly) / tot).toFixed(0) + ' %');
console.log('Projection nette sur 797 829 : ' + Math.round(797829 * (1 - (dupN + addrOnly) / tot)).toLocaleString('fr-FR'));
