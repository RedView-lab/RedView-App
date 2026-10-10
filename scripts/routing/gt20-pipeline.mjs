import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1. Read real GT20 GPX file
// Données hors dépôt : REDVIEW_BENCH_DATA (défaut ~/Downloads), comme script-test-bench/core/data-paths.ts.
const BENCH_DATA_DIR = process.env.REDVIEW_BENCH_DATA ?? path.join(os.homedir(), 'Downloads');
const inputPath = path.join(BENCH_DATA_DIR, 'GT20.gpx');
const outputPath = path.join(BENCH_DATA_DIR, 'GT20_POI.gpx');

console.log(`\x1b[36m[RedView Real Test]\x1b[0m 1. Reading ${inputPath}...`);
const rawXml = fs.readFileSync(inputPath, 'utf-8');

// Analyse les points avec l'analyseur à regex de RedView
const trkptRegex = /<trkpt\s+lat=["']([^"']+)["']\s+lon=["']([^"']+)["'][^>]*>(?:[\s\S]*?<ele>([^<]+)<\/ele>)?[\s\S]*?<\/trkpt>/gi;
const points = [];
let m;
while ((m = trkptRegex.exec(rawXml)) !== null) {
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  const elevationM = m[3] ? parseFloat(m[3]) : null;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    points.push({ lat, lon, elevationM });
  }
}
console.log(`\x1b[32m✔\x1b[0m Parsed ${points.length} points from GT20.gpx`);

// Calcule les distances cumulées
let totalDistM = 0;
const R = 6371008.8;
for (let i = 0; i < points.length; i++) {
  if (i === 0) {
    points[i].distanceM = 0;
  } else {
    const p1 = points[i - 1];
    const p2 = points[i];
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lon - p1.lon) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    totalDistM += d;
    points[i].distanceM = totalDistM;
  }
}
console.log(`\x1b[32m✔\x1b[0m Total course distance: ${(totalDistM / 1000).toFixed(1)} km`);

// 2. Récupère les vrais POI du VPS Oracle avec un rayon de 40 m
const VPS_POI_URL = 'http://141.145.220.99/poi/corridor';
const ALL_CATEGORIES = [
  'drinking_water', 'water_point', 'water_tap', 'spring', 'fountain',
  'supermarket', 'convenience', 'bakery', 'butcher', 'marketplace',
  'restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'ice_cream', 'vending_machine',
  'hotel', 'alpine_hut', 'wilderness_hut', 'shelter', 'camp_site', 'caravan_site',
  'bicycle', 'bicycle_repair', 'compressed_air', 'charging_station', 'outdoor_shop',
  'pharmacy', 'hospital', 'clinic', 'doctors', 'defibrillator', 'police',
  'train_station', 'bus_station', 'ferry_terminal',
  'toilets', 'shower', 'fuel', 'atm', 'post_office', 'laundry',
  'pass', 'viewpoint', 'picnic_site',
];

// Échantillonne un point tous les ~35 m pour une couverture complète du corridor sans envoyer 16 k coordonnées d'un coup
const sampled = [points[0]];
let last = points[0];
let acc = 0;
for (let i = 1; i < points.length; i++) {
  const d = points[i].distanceM - points[i - 1].distanceM;
  acc += d;
  if (acc >= 35 || i === points.length - 1) {
    sampled.push(points[i]);
    acc = 0;
  }
}
console.log(`\x1b[36m[RedView Real Test]\x1b[0m 2. Querying Oracle VPS (${VPS_POI_URL}) with 40m radius along ${sampled.length} corridor points...`);

const CHUNK_SIZE = 1200;
const fetchedPoisMap = new Map();

for (let i = 0; i < sampled.length; i += CHUNK_SIZE) {
  const chunk = sampled.slice(i, i + CHUNK_SIZE);
  const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
  const totalChunks = Math.ceil(sampled.length / CHUNK_SIZE);
  process.stdout.write(`   → Chunk ${chunkNum}/${totalChunks}... `);

  const res = await fetch(VPS_POI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: chunk.map(p => [p.lat, p.lon]),
      radiusM: 40,
      categories: ALL_CATEGORIES,
    }),
  });

  if (!res.ok) {
    throw new Error(`VPS HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const count = json.features ? json.features.length : 0;
  console.log(`received ${count} POIs`);

  if (json.features) {
    for (const f of json.features) {
      fetchedPoisMap.set(f.id, f);
    }
  }
}

const realPois = Array.from(fetchedPoisMap.values());
console.log(`\x1b[32m✔\x1b[0m Total POIs retrieved from VPS (radius 40m): ${realPois.length}`);

// Let's mark some key POIs as favorite (e.g. water points, passes/cols, bakeries)
let favCount = 0;
for (const p of realPois) {
  if (p.category === 'pass' || p.category === 'drinking_water' || p.category === 'fountain' || p.category === 'spring') {
    p.favorite = true;
    favCount++;
  }
}
console.log(`\x1b[32m✔\x1b[0m Marked ${favCount} water points & passes as favorite (to test favorite inclusion)`);

// 3. Construit l'objet Itinéraire de RedView et teste les propres fonctions d'export de RedView
console.log(`\x1b[36m[RedView Real Test]\x1b[0m 3. Invoking RedView exporter (exportGpx / exportKml)...`);

// Importe les vraies fonctions d'export compilées de RedView
const { buildItineraryGpx } = await import('../../src/features/exporter/lib/exportGpx.ts');
const { buildItineraryKml } = await import('../../src/features/exporter/lib/exportKml.ts');
const { collectExportAnchors } = await import('../../src/features/exporter/lib/exportHelpers.ts');

const itinerary = {
  id: 'gt20-corsica',
  name: 'GT20 Corse',
  color: '#c50000',
  timeline: [
    { id: 'start', kind: 'start', label: 'Bastia (Depart GT20)', lat: points[0].lat, lon: points[0].lon, distanceKm: 0 },
    { id: 'end', kind: 'end', label: 'Bonifacio (Arrivee GT20)', lat: points[points.length - 1].lat, lon: points[points.length - 1].lon, distanceKm: totalDistM / 1000 },
  ],
  poiFeatures: realPois,
  gpxRoute: {
    name: 'GT20',
    points: points,
  },
};

// Test A : avec pois: 'favorites' (seulement les 101 points d'eau et cols favoris)
const favAnchors = collectExportAnchors(itinerary, points, { pois: 'favorites' });
console.log(`\x1b[32m✔\x1b[0m collectExportAnchors with pois=favorites: ${favAnchors.length} anchors (including Depart/Arrivee)`);
const sampleFav = favAnchors.find(a => a.kind === 'poi');
if (sampleFav) {
  console.log(`   Sample favorite POI: [${sampleFav.poiCategory}] "${sampleFav.name}" at km ${(sampleFav.distanceM / 1000).toFixed(1)}`);
}

// Test B : avec pois: 'all' (TOUS les 624 vrais POI)
const allAnchors = collectExportAnchors(itinerary, points, { pois: 'all' });
console.log(`\x1b[32m✔\x1b[0m collectExportAnchors with pois=all: ${allAnchors.length} anchors`);

// Generate GPX with ALL POIs as requested: "refait un gpx GT20_POI.gpx avec tout les poi, 40m de recherche"
const gpxAllPois = buildItineraryGpx(itinerary, { pois: 'all' });
fs.writeFileSync(outputPath, gpxAllPois, 'utf-8');
console.log(`\x1b[32m✔\x1b[0m Generated and saved GPX: ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

// Enregistre aussi le KML pour vérification
const kmlOutputPath = path.join(BENCH_DATA_DIR, 'GT20_POI.kml');
const kmlAllPois = buildItineraryKml(itinerary, { pois: 'all' });
fs.writeFileSync(kmlOutputPath, kmlAllPois, 'utf-8');
console.log(`\x1b[32m✔\x1b[0m Generated and saved KML: ${kmlOutputPath} (${(fs.statSync(kmlOutputPath).size / 1024).toFixed(1)} KB)`);

// 4. Valide le GPX de sortie
console.log(`\x1b[36m[RedView Real Test]\x1b[0m 4. Validating output file...`);
const outputText = fs.readFileSync(outputPath, 'utf-8');
const wptMatches = outputText.match(/<wpt\b/g);
const trkptMatches = outputText.match(/<trkpt\b/g);
console.log(`   - Output contains <wpt> count : ${wptMatches ? wptMatches.length : 0}`);
console.log(`   - Output contains <trkpt> count: ${trkptMatches ? trkptMatches.length : 0}`);
console.log(`\x1b[32m✔ SUCCESS: Real RedView export generated with all VPS POIs!\x1b[0m`);
