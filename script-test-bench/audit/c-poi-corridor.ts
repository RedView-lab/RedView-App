/**
 * C2 / C1 — Corridor POI : échantillonnage frontend réel + logique de grille du
 * serveur POI (copie fidèle de server/poi-server/server.js, POST /corridor,
 * lignes ~383-458) → rappel géométrique ; puis vérification sur la prod.
 *
 * Usage :
 *   npx tsx script-test-bench/audit/c-poi-corridor.ts            # géométrie seule (hors ligne)
 *   npx tsx script-test-bench/audit/c-poi-corridor.ts --live     # + 7 requêtes sur https://app.redview.tech
 *
 * Sortie != 0 si le rappel serveur (POI à < r de la trace effectivement renvoyés)
 * est < 99 % pour le rayon par défaut, ou si la prod renvoie 200 + [] sur une
 * requête qui devrait échouer (413 masqué).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sampleRouteByDistance } from '../../src/features/poi/lib/gpx-loader.ts';
import { clampCorridorRadiusM } from '../../src/features/poi/lib/poi-api.ts';
import { DEFAULT_POI_DISTANCE_M, createDefaultItinerary } from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import { GT20, TDF, haversineM, readGpxPoints, routeLength, throttledFetch } from './c-lib.ts';

const LIVE = process.argv.includes('--live');
const PROD = 'https://app.redview.tech/api/poi?op=corridor';
const failures: string[] = [];

// Copie de PANEL_TO_FEATURE_POI (useItineraryPoiMap.ts:27, non exporté).
const PANEL_TO_FEATURE_POI: Record<string, string[]> = {
  fountains: ['drinking_water', 'water_point', 'water_tap', 'spring', 'fountain'],
  toilets: ['toilets', 'shower'],
  supermarkets: ['supermarket', 'convenience', 'marketplace'],
  gasStations: ['fuel', 'charging_station'],
  bakeries: ['bakery', 'butcher', 'ice_cream'],
  fastFood: ['fast_food', 'vending_machine'],
  cafes: ['cafe'],
  bars: ['bar', 'pub'],
  restaurants: ['restaurant'],
  bikeShops: ['bicycle', 'bicycle_repair', 'compressed_air', 'outdoor_shop'],
  hotels: ['hotel', 'camp_site', 'caravan_site'],
  refuges: ['alpine_hut', 'wilderness_hut', 'shelter'],
  passes: ['pass'],
  health: ['pharmacy', 'hospital', 'clinic', 'doctors', 'defibrillator', 'police'],
  transport: ['train_station', 'bus_station', 'ferry_terminal', 'atm', 'post_office', 'laundry'],
};
const defaultIt = createDefaultItinerary(1);
const CATEGORIES = Object.entries(defaultIt.poi)
  .filter(([k, v]) => k !== 'transport' && (v as { enabled?: boolean }).enabled)
  .flatMap(([k]) => PANEL_TO_FEATURE_POI[k] ?? []);

type LL = { lat: number; lon: number };

/** Copie de usePoi.ts fetchCorridorPois (lignes ~273-287) : rayon, longueur approx, pas, échantillons. */
function frontendSamples(points: LL[], radiusInput: number) {
  const radius = clampCorridorRadiusM(radiusInput);
  let approxLenM = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const dLat = (b.lat - a.lat) * 111_320;
    const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    approxLenM += Math.sqrt(dLat * dLat + dLon * dLon);
  }
  const lenBasedSpacing = approxLenM > 0 ? approxLenM / 8_000 : 0;
  const spacing = Math.max(10, radius * 1.4, lenBasedSpacing);
  const sampled = sampleRouteByDistance(points, spacing, 8_000);
  return { radius, spacing, sampled };
}

/** Copie fidèle de la sélection serveur (server.js POST /corridor, grille + test segment). */
function serverAccept(pointsLL: LL[], radius: number, pois: LL[]): boolean[] {
  const points = pointsLL.map((p) => [p.lat, p.lon] as [number, number]);
  const degLat = radius / 110574;
  const degLon = radius / (111320 * Math.cos((points[0]![0] * Math.PI) / 180));
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
  }
  minLat -= degLat; maxLat += degLat; minLon -= degLon; maxLon += degLon;
  const originLat = (minLat + maxLat) / 2;
  const originLon = (minLon + maxLon) / 2;
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  const cellM = Math.max(radius * 2, 100);
  const toCellX = (lon: number) => Math.floor(((lon - originLon) * mPerDegLon) / cellM);
  const toCellY = (lat: number) => Math.floor(((lat - originLat) * mPerDegLat) / cellM);
  const cellKey = (cx: number, cy: number) => `${cx}:${cy}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < points.length; i++) {
    const key = cellKey(toCellX(points[i]![1]), toCellY(points[i]![0]));
    const b = grid.get(key); if (b) b.push(i); else grid.set(key, [i]);
  }
  const radiusSq = radius * radius;
  return pois.map((poi) => {
    const cx = toCellX(poi.lon); const cy = toCellY(poi.lat);
    const segments = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(cellKey(cx + dx, cy + dy));
      if (!bucket) continue;
      for (const idx of bucket) { if (idx > 0) segments.add(idx - 1); if (idx < points.length - 1) segments.add(idx); }
    }
    let min = Infinity;
    for (const i of segments) { const d = segDistSq(points[i]!, points[i + 1]!, poi); if (d < min) { min = d; if (min <= radiusSq) break; } }
    return min <= radiusSq;
  });
}

function segDistSq(a: [number, number], b: [number, number], poi: LL): number {
  const [lat1, lon1] = a; const [lat2, lon2] = b;
  const kx = 111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180); const ky = 110574;
  const x2 = (lon2 - lon1) * kx, y2 = (lat2 - lat1) * ky, px = (poi.lon - lon1) * kx, py = (poi.lat - lat1) * ky;
  const L = x2 * x2 + y2 * y2;
  let t = L === 0 ? 0 : (px * x2 + py * y2) / L; t = Math.max(0, Math.min(1, t));
  const dx = px - t * x2, dy = py - t * y2; return dx * dx + dy * dy;
}

/** Distance exacte min (m) d'un POI à une polyligne, indexée par cellules de 2 km. */
function makeDistIndex(pointsLL: LL[]) {
  const pts = pointsLL.map((p) => [p.lat, p.lon] as [number, number]);
  const CELL = 0.02; const idx = new Map<string, number[]>();
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    for (let x = Math.floor(Math.min(a[1], b[1]) / CELL); x <= Math.floor(Math.max(a[1], b[1]) / CELL); x++)
      for (let y = Math.floor(Math.min(a[0], b[0]) / CELL); y <= Math.floor(Math.max(a[0], b[0]) / CELL); y++) {
        const k = `${x}:${y}`; const l = idx.get(k); if (l) l.push(i); else idx.set(k, [i]);
      }
  }
  return (poi: LL) => {
    const x0 = Math.floor(poi.lon / CELL), y0 = Math.floor(poi.lat / CELL); let min = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of idx.get(`${x0 + dx}:${y0 + dy}`) ?? []) {
      const d = segDistSq(pts[i]!, pts[i + 1]!, poi); if (d < min) min = d;
    }
    return Math.sqrt(min);
  };
}

/** POI synthétiques le long de la trace ORIGINALE, décalés perpendiculairement de `frac`·r. */
function syntheticPois(points: LL[], r: number, n: number, frac: number): LL[] {
  const total = routeLength(points); const step = total / n; const out: LL[] = [];
  let next = step / 2, acc = 0, side = 1;
  for (let i = 1; i < points.length && out.length < n; i++) {
    const a = points[i - 1]!, b = points[i]!; const seg = haversineM(a, b);
    while (seg > 0 && acc + seg >= next && out.length < n) {
      const t = (next - acc) / seg;
      const lat = a.lat + t * (b.lat - a.lat), lon = a.lon + t * (b.lon - a.lon);
      const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
      const ex = (b.lon - a.lon) * kx, ey = (b.lat - a.lat) * ky, L = Math.hypot(ex, ey);
      const off = frac * r * side; side = -side;
      out.push({ lat: lat + ((ex / L) * off) / ky, lon: lon + ((-ey / L) * off) / kx });
      next += step;
    }
    acc += seg;
  }
  return out;
}

function gpxStats(points: LL[]) {
  const segs = points.slice(1).map((p, i) => haversineM(points[i]!, p)).sort((a, b) => a - b);
  const q = (f: number) => segs[Math.floor(f * (segs.length - 1))]!;
  return { n: points.length, km: routeLength(points) / 1000, med: q(0.5), p99: q(0.99), max: segs[segs.length - 1]! };
}

function geometry(name: string, points: LL[]) {
  const st = gpxStats(points);
  console.log(`\n${name}: ${st.n} pts, ${st.km.toFixed(0)} km, segment GPX médian ${st.med.toFixed(0)} m, p99 ${st.p99.toFixed(0)} m, max ${st.max.toFixed(0)} m`);
  console.log('  r(m)  pas(m)  échant.  écart max(m)  rappel corde  rappel serveur  pertes grille seule  rappel serveur @0,9r   (20 000 POI synthétiques à 0,5·r de la trace réelle)');
  const results: Record<number, number> = {};
  for (const r of [20, 40, 100, 300, 1000]) {
    const { spacing, sampled } = frontendSamples(points, r);
    let maxGap = 0; for (let i = 1; i < sampled.length; i++) maxGap = Math.max(maxGap, haversineM(sampled[i - 1]!, sampled[i]!));
    const pois = syntheticPois(points, r, 20_000, 0.5);
    const dist = makeDistIndex(sampled);
    const chordOk = pois.filter((p) => dist(p) <= r).length;
    const accFlags = serverAccept(sampled, r, pois);
    const acc = accFlags.filter(Boolean).length;
    const gridOnly = pois.filter((p, i) => !accFlags[i] && dist(p) <= r).length;
    const pois9 = syntheticPois(points, r, 20_000, 0.9);
    const acc9 = serverAccept(sampled, r, pois9).filter(Boolean).length;
    results[r] = acc / pois.length;
    console.log(`  ${String(r).padStart(4)}  ${spacing.toFixed(0).padStart(6)}  ${String(sampled.length).padStart(7)}  ${maxGap.toFixed(0).padStart(12)}  ${(100 * chordOk / pois.length).toFixed(1).padStart(11)} %  ${(100 * acc / pois.length).toFixed(1).padStart(13)} %  ${String(gridOnly).padStart(18)}  ${(100 * acc9 / pois9.length).toFixed(1).padStart(18)} %`);
  }
  return results;
}

/** Densifie une polyligne (interpolation linéaire tous les `step` m) : référence « vérité ». */
function densify(points: LL[], step: number): LL[] {
  const out: LL[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!; const d = haversineM(a, b); const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push({ lat: a.lat + (k / n) * (b.lat - a.lat), lon: a.lon + (k / n) * (b.lon - a.lon) });
  }
  return out;
}

function sliceByKm(points: LL[], fromKm: number, toKm: number): LL[] {
  const out: LL[] = []; let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) acc += haversineM(points[i - 1]!, points[i]!);
    if (acc >= fromKm * 1000 && acc <= toKm * 1000) out.push(points[i]!);
  }
  return out;
}

/** Fenêtre de `win` km où la sélection serveur perd le plus de POI synthétiques (tronçon sinueux). */
function worstWindow(points: LL[], r: number, win: number): [number, number] {
  const { sampled } = frontendSamples(points, r);
  const totalKm = routeLength(points) / 1000;
  const n = 10_000;
  const pois = syntheticPois(points, r, n, 0.5);
  const ok = serverAccept(sampled, r, pois);
  const bins = new Array(Math.ceil(totalKm / win)).fill(0);
  pois.forEach((_, i) => { if (!ok[i]) bins[Math.min(bins.length - 1, Math.floor(((i + 0.5) / n) * totalKm / win))]++; });
  const best = bins.indexOf(Math.max(...bins));
  return [best * win, (best + 1) * win];
}

type Feature = { id: number | string; lat: number; lon: number; category: string };
async function post(points: LL[], radiusM: number, categories: string[]) {
  const body = JSON.stringify({ points: points.map((p) => [p.lat, p.lon]), radiusM, categories });
  const t0 = performance.now();
  const res = await throttledFetch(PROD, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
  const text = await res.text();
  const ms = performance.now() - t0;
  let features: Feature[] = [];
  try { features = (JSON.parse(text) as { features?: Feature[] }).features ?? []; } catch { /* */ }
  return { status: res.status, ms, bytes: body.length, respBytes: text.length, features, cache: res.headers.get('cache-control'), text: text.slice(0, 120) };
}

async function live(name: string, points: LL[], r: number, sliceKm: [number, number]) {
  const { sampled } = frontendSamples(points, r);
  const full = await post(sampled, r, CATEGORIES);
  console.log(`  ${name} r=${r} : HTTP ${full.status} en ${full.ms.toFixed(0)} ms, corps ${(full.bytes / 1024).toFixed(0)} Ko, ${sampled.length} échant., ${full.features.length} POI`);
  const slice = sliceByKm(points, sliceKm[0], sliceKm[1]);
  const dense = densify(slice, 25);
  const truth = await post(dense, r, CATEGORIES);
  const fullIds = new Set(full.features.map((f) => f.id));
  const missing = truth.features.filter((f) => !fullIds.has(f.id));
  // La réimplémentation prédit-elle exactement les mêmes manques ?
  const predicted = serverAccept(sampled, r, truth.features);
  const predictedMissing = truth.features.filter((_, i) => !predicted[i]);
  const agree = predictedMissing.length === missing.length && predictedMissing.every((f) => !fullIds.has(f.id));
  console.log(`  tronçon km ${sliceKm[0]}-${sliceKm[1]} densifié (${dense.length} pts, HTTP ${truth.status}, ${truth.ms.toFixed(0)} ms) : ${truth.features.length} POI réels à < ${r} m ; absents de la requête complète : ${missing.length} (${truth.features.length ? (100 * missing.length / truth.features.length).toFixed(0) : 0} %) ; réimplémentation grille prédit ${predictedMissing.length} manquants (${agree ? 'accord exact' : 'désaccord'})`);
  for (const f of missing.slice(0, 5)) console.log(`     manquant : ${f.category} #${f.id} (${f.lat.toFixed(5)}, ${f.lon.toFixed(5)})`);
  return { full, truth, missing: missing.length, truthN: truth.features.length, agree };
}

async function main() {
  console.log(`Catégories recherchées par défaut (${CATEGORIES.length}) ; distance X par défaut = ${DEFAULT_POI_DISTANCE_M} m`);
  const gt20 = readGpxPoints(GT20);
  const tdf = readGpxPoints(TDF);
  const g = geometry('GT20', gt20);
  const t = geometry('Tour de France 2026', tdf);
  // Itinéraire multi-jours synthétique (~2 400 km) : GT20 + 3 copies décalées
  // (géométrie routière réelle), reliées par des liaisons droites.
  const long: LL[] = [];
  for (let k = 0; k < 4; k++) {
    const src = (k % 2 ? [...gt20].reverse() : gt20).map((p) => ({ lat: p.lat + k * 1.2, lon: p.lon + k * 0.3 }));
    // Liaison densifiée tous les 30 m (pas de segment GPX artificiellement long).
    if (long.length) long.push(...densify([long[long.length - 1]!, src[0]!], 30).slice(1, -1));
    long.push(...src);
  }
  const l = geometry('Multi-jours synthétique (4 x GT20 décalés)', long);
  for (const [name, res] of [['GT20', g], ['TdF', t], ['Multi-jours', l]] as const) {
    if (res[DEFAULT_POI_DISTANCE_M] !== undefined && res[DEFAULT_POI_DISTANCE_M]! < 0.99) {
      failures.push(`${name}: rappel serveur ${(100 * res[DEFAULT_POI_DISTANCE_M]!).toFixed(1)} % au rayon par défaut ${DEFAULT_POI_DISTANCE_M} m`);
    }
  }

  // Vrais POI GT20 déjà récupérés par test-poi-autosort.ts (échantillonnage à
  // 1,4·r SANS plafond longueur/8000) : combien la requête frontend (pas
  // plafonné) en renverrait-elle ? (hors ligne, cache dans os.tmpdir()).
  const cacheDir = path.join((await import('node:os')).tmpdir(), 'redview-poi-autosort');
  if (fs.existsSync(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir).filter((n) => /^pois-.*-(20|40)\.json$/.test(n))) {
      const r = Number(/-(\d+)\.json$/.exec(f)![1]);
      const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')) as LL[];
      const { sampled, spacing } = frontendSamples(gt20, r);
      const ok = serverAccept(sampled, r, cached).filter(Boolean).length;
      console.log(`\nCache ${f} (${cached.length} POI réels, pas 1,4·r) → requête frontend (pas ${spacing.toFixed(0)} m) en garde ${ok} : ${cached.length - ok} perdus (${(100 * (cached.length - ok) / cached.length).toFixed(1)} %)`);
    }
  }

  if (LIVE) {
    console.log('\n-- Prod https://app.redview.tech (lecture seule, >= 3,2 s entre requêtes) --');
    const ONLY_413 = process.argv.includes('--only-413');
    let big = { status: 0, features: [] as Feature[] };
    if (!ONLY_413) {
      const a = await live('GT20', gt20, 20, worstWindow(gt20, 20, 30));
      const b = await live('TdF', tdf, 20, worstWindow(tdf, 20, 30));
      for (const [n, x] of [['GT20', a], ['TdF', b]] as const) {
        if (x.truthN > 0 && x.missing / x.truthN > 0.01) failures.push(`${n} prod : ${x.missing}/${x.truthN} POI réels à < 20 m absents de la recherche corridor`);
      }
      const g1k = frontendSamples(gt20, 1000);
      const r1 = await post(g1k.sampled, 1000, CATEGORIES);
      console.log(`  GT20 r=1000 : HTTP ${r1.status} en ${r1.ms.toFixed(0)} ms, ${r1.features.length} POI, réponse ${(r1.respBytes / 1048576).toFixed(1)} Mo`);
      const t10k = frontendSamples(tdf, 10_000);
      const b10 = await post(t10k.sampled, 10_000, CATEGORIES);
      big = b10;
      console.log(`  TdF r=10000 (max UI/serveur) : HTTP ${b10.status} en ${b10.ms.toFixed(0)} ms, ${b10.features.length} POI, cache-control=${b10.cache}, corps="${b10.text}"`);
    }
    // Boucle de France multi-jours (~2 900 km, villes reliées en ligne droite,
    // densifiée à 30 m comme un GPX) avec X = 10 km (ex. hôtels « à 10 km »).
    const cities: LL[] = [
      { lat: 48.857, lon: 2.352 }, { lat: 45.764, lon: 4.836 }, { lat: 43.296, lon: 5.370 },
      { lat: 43.605, lon: 1.444 }, { lat: 44.838, lon: -0.579 }, { lat: 47.218, lon: -1.554 }, { lat: 48.857, lon: 2.352 },
    ];
    const loop = densify(cities, 30);
    const lf = frontendSamples(loop, 10_000);
    const big2 = await post(lf.sampled, 10_000, CATEGORIES);
    console.log(`  Boucle France ${(routeLength(loop) / 1000).toFixed(0)} km r=10000 : HTTP ${big2.status} en ${big2.ms.toFixed(0)} ms, ${big2.features.length} POI, cache-control=${big2.cache}, corps="${big2.text}"`);
    for (const [n, x] of [['TdF r=10000', big], ['Boucle France r=10000', big2]] as const) {
      if (x.status === 200 && x.features.length === 0) failures.push(`${n} : 200 + 0 POI (413 « Corridor trop large » amont masqué par api/poi.ts)`);
    }
  }

  console.log(failures.length ? `\nFAIL ${failures.length} échec(s):\n  - ${failures.join('\n  - ')}` : '\nOK');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
void fs; void path;
