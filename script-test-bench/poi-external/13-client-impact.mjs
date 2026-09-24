/**
 * Impact client, les deux regimes :
 *   - nominal  : filtre lateral par defaut a 40 m (ce qui devient un marqueur DOM)
 *   - curseur  : filtre lateral pousse a 1000 m (= tout le corridor)
 */
const CATS = ['drinking_water','water_point','water_tap','spring','fountain','supermarket',
'convenience','bakery','butcher','marketplace','restaurant','fast_food','cafe','bar','pub',
'ice_cream','vending_machine','hotel','alpine_hut','wilderness_hut','shelter','camp_site',
'caravan_site','bicycle','bicycle_repair','compressed_air','charging_station','outdoor_shop',
'pharmacy','hospital','clinic','doctors','defibrillator','police','train_station','bus_station',
'ferry_terminal','toilets','shower','fuel','atm','post_office','laundry','pass','viewpoint','picnic_site'];

// Categories activees par defaut dans le panneau (defaultState.ts).
const ENABLED_BY_DEFAULT = new Set(['fountain','toilets','supermarket','fuel','bakery','fast_food',
'cafe','bar','restaurant','bicycle','hotel','alpine_hut']);

const GROWTH = {
  restaurant: 218225/92139, hotel: 99139/42043, doctors: 56572/12541, bakery: 71941/29491,
  atm: 62996/28936, convenience: 50020/22519, supermarket: 41164/15707, pharmacy: 40122/19133,
  butcher: 27458/10727, bar: 35658/20743, fuel: 24238/11084, laundry: 18215/6337,
  camp_site: 18787/9153, outdoor_shop: 14468/4036, post_office: 28655/17458, cafe: 25323/17129,
  fast_food: 39922/30298, clinic: 10417/1993, hospital: 10519/2383, police: 8300/5936,
  pub: 6452/4422, train_station: 6771/4022, marketplace: 5324/3905, caravan_site: 4417/3598,
  ice_cream: 2732/1803, bicycle: 4396/3837, bicycle_repair: 3169/2937, fountain: 21775/21461,
  charging_station: 21629/21396, bus_station: 943/805, ferry_terminal: 671/616,
};

const ROUTE = [
  [45.764, 4.836], [45.700, 4.900], [45.620, 5.000], [45.560, 5.100],
  [45.500, 5.200], [45.430, 5.320], [45.350, 5.420], [45.290, 5.520],
  [45.230, 5.620], [45.190, 5.724],
  [45.150, 5.850], [45.120, 6.000], [45.100, 6.150], [45.080, 6.300],
  [45.060, 6.450], [45.050, 6.600], [45.040, 6.750], [45.035, 6.850],
  [45.020, 6.950], [44.990, 7.050], [44.950, 7.150], [44.900, 7.250],
  [44.899, 6.645],
];

function densify(points, stepM = 250) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [a1, o1] = points[i - 1]; const [a2, o2] = points[i];
    const dLat = (a2 - a1) * 111320;
    const dLon = (o2 - o1) * 111320 * Math.cos(((a1 + a2) / 2) * Math.PI / 180);
    const d = Math.hypot(dLat, dLon);
    const n = Math.max(1, Math.round(d / stepM));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a1 + (a2 - a1) * t, o1 + (o2 - o1) * t]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

const pts = densify(ROUTE);

function lateralM(lat, lon, route) {
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const [a1, o1] = route[i - 1]; const [a2, o2] = route[i];
    const x2 = (o2 - o1) * mPerDegLon; const y2 = (a2 - a1) * mPerDegLat;
    const px = (lon - o1) * mPerDegLon; const py = (lat - a1) * mPerDegLat;
    const len2 = x2 * x2 + y2 * y2;
    let t = len2 === 0 ? 0 : (px * x2 + py * y2) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * x2; const dy = py - t * y2;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

const res = await fetch('http://141.145.220.99/poi/corridor', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ points: pts, radiusM: 1000, categories: CATS }),
  signal: AbortSignal.timeout(240000),
});
const { features } = await res.json();

let corrAv = 0; let corrAp = 0; let defAv = 0; let defAp = 0;
const perCat = new Map();
for (const f of features) {
  const g = GROWTH[f.category] ?? 1;
  const d = lateralM(f.lat, f.lon, ROUTE);
  const enabled = ENABLED_BY_DEFAULT.has(f.category);
  corrAv++; corrAp += g;
  if (d <= 40 && enabled) { defAv++; defAp += g; }
  if (!perCat.has(f.category)) perCat.set(f.category, { n: 0, d40: 0, g });
  const e = perCat.get(f.category);
  e.n++; if (d <= 40) e.d40++;
}

console.log(`Itinéraire Lyon → Briançon (~269 km), corridor serveur 1000 m\n`);
console.log('REGIME                                    AVANT      APRES      x');
console.log('Curseur pousse a 1000 m (tout le corridor)');
console.log('  marqueurs DOM crees                  ' + String(Math.round(corrAv)).padStart(9)
  + String(Math.round(corrAp)).padStart(11) + ('x' + (corrAp / corrAv).toFixed(2)).padStart(7));
console.log('Nominal (defaut 40 m, categories actives)');
console.log('  marqueurs DOM crees                  ' + String(defAv).padStart(9)
  + String(Math.round(defAp)).padStart(11) + ('x' + (defAp / defAv).toFixed(2)).padStart(7));

console.log('\nDetail du regime nominal (categories actives par defaut, <= 40 m) :');
const rows = [...perCat.entries()].filter(([c]) => ENABLED_BY_DEFAULT.has(c))
  .map(([c, e]) => [c, e.d40, Math.round(e.d40 * e.g), e.g]).filter((r) => r[1] > 0)
  .sort((a, b) => b[2] - a[2]);
console.log('CATEGORIE'.padEnd(18) + 'AVANT'.padStart(8) + 'APRES'.padStart(8) + 'x'.padStart(7));
for (const [c, n, p, g] of rows) {
  console.log(c.padEnd(18) + String(n).padStart(8) + String(p).padStart(8) + ('x' + g.toFixed(2)).padStart(7));
}
console.log('\nPOI charges depuis le serveur (dedup + filtrage client sur tout) :');
console.log('  ' + corrAv.toLocaleString('fr-FR') + '  ->  ' + Math.round(corrAp).toLocaleString('fr-FR'));
