import fs from 'node:fs';
import path from 'node:path';

const VPS_POI_URL = 'http://141.145.220.99/poi/corridor';
const INPUT_GPX = 'C:/Users/simon/Downloads/GT20.gpx';
const OUTPUT_GPX_1 = 'C:/Users/simon/Downloads/GT20_POI.gpx';
const OUTPUT_GPX_2 = path.resolve('GT20_POI.gpx');
const RADIUS_M = 40;

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

const CATEGORY_TO_SYM = {
  drinking_water: 'Drinking Water',
  water_point: 'Drinking Water',
  water_tap: 'Drinking Water',
  spring: 'Drinking Water',
  fountain: 'Drinking Water',
  toilets: 'Restroom',
  shower: 'Restroom',
  supermarket: 'Store',
  convenience: 'Store',
  marketplace: 'Store',
  fuel: 'Gas Station',
  bakery: 'Restaurant',
  butcher: 'Store',
  fast_food: 'Restaurant',
  vending_machine: 'Store',
  ice_cream: 'Restaurant',
  cafe: 'Restaurant',
  bar: 'Bar',
  pub: 'Bar',
  restaurant: 'Restaurant',
  bicycle: 'Bike Trail',
  bicycle_repair: 'Bike Trail',
  compressed_air: 'Bike Trail',
  charging_station: 'Gas Station',
  outdoor_shop: 'Store',
  hotel: 'Lodging',
  camp_site: 'Campground',
  caravan_site: 'Campground',
  alpine_hut: 'Lodging',
  wilderness_hut: 'Lodging',
  shelter: 'Lodging',
  pass: 'Summit',
  viewpoint: 'Scenic Area',
  picnic_site: 'Picnic Area',
  pharmacy: 'First Aid',
  hospital: 'Medical Facility',
  clinic: 'Medical Facility',
  doctors: 'Medical Facility',
  defibrillator: 'First Aid',
  police: 'Police Station',
  train_station: 'Ground Transportation',
  bus_station: 'Ground Transportation',
  ferry_terminal: 'Ground Transportation',
  atm: 'Bank',
  post_office: 'Post Office',
  laundry: 'Building',
};

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseGpxPoints(xml) {
  const points = [];
  const trkptRegex = /<trkpt\s+lat=["']([^"']+)["']\s+lon=["']([^"']+)["'][^>]*>(?:[\s\S]*?<ele>([^<]+)<\/ele>)?[\s\S]*?<\/trkpt>/gi;
  let match;
  while ((match = trkptRegex.exec(xml)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const ele = match[3] ? parseFloat(match[3]) : null;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({ lat, lon, ele });
    }
  }

  // Also check rtept if no trkpt
  if (points.length === 0) {
    const rteptRegex = /<rtept\s+lat=["']([^"']+)["']\s+lon=["']([^"']+)["'][^>]*>(?:[\s\S]*?<ele>([^<]+)<\/ele>)?[\s\S]*?<\/rtept>/gi;
    while ((match = rteptRegex.exec(xml)) !== null) {
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      const ele = match[3] ? parseFloat(match[3]) : null;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        points.push({ lat, lon, ele });
      }
    }
  }

  return points;
}

function haversineM(p1, p2) {
  const R = 6371008.8;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Subsample points along route so that consecutive points are ~30m apart
function samplePoints(points, targetSpacingM = 30) {
  if (points.length <= 2) return points;
  const sampled = [points[0]];
  let last = points[0];
  let accM = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversineM(last, points[i]);
    accM += d;
    last = points[i];
    if (accM >= targetSpacingM || i === points.length - 1) {
      sampled.push(points[i]);
      accM = 0;
    }
  }
  return sampled;
}

async function main() {
  console.log(`\x1b[36m[GT20 POI Test]\x1b[0m Reading input GPX from: ${INPUT_GPX}`);
  if (!fs.existsSync(INPUT_GPX)) {
    throw new Error(`File not found: ${INPUT_GPX}`);
  }

  const rawXml = fs.readFileSync(INPUT_GPX, 'utf-8');
  const points = parseGpxPoints(rawXml);
  console.log(`\x1b[32m✔\x1b[0m Parsed ${points.length} track points from GT20.gpx`);

  // Sample for corridor query
  const sampled = samplePoints(points, 35);
  console.log(`\x1b[36m[GT20 POI Test]\x1b[0m Subsampled to ${sampled.length} points for VPS corridor query (spacing ~35m, radius: ${RADIUS_M}m)`);

  // Query VPS in chunks if points count is large (e.g. max 1500 points per request)
  const CHUNK_SIZE = 1200;
  const allFeaturesMap = new Map();

  for (let i = 0; i < sampled.length; i += CHUNK_SIZE) {
    const chunk = sampled.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(sampled.length / CHUNK_SIZE);
    process.stdout.write(`\x1b[36m[GT20 POI Test]\x1b[0m Fetching corridor POIs from VPS (chunk ${chunkNum}/${totalChunks})... `);

    const body = JSON.stringify({
      points: chunk.map((p) => [p.lat, p.lon]),
      radiusM: RADIUS_M,
      categories: ALL_CATEGORIES,
    });

    const res = await fetch(VPS_POI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`VPS POI HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const count = data.features ? data.features.length : 0;
    console.log(`received ${count} POIs`);

    if (data.features) {
      for (const feat of data.features) {
        allFeaturesMap.set(feat.id, feat);
      }
    }
  }

  const dedupedPois = Array.from(allFeaturesMap.values());
  console.log(`\x1b[32m✔\x1b[0m Total unique POIs fetched along GT20: ${dedupedPois.length}`);

  // Breakdown by category
  const byCategory = {};
  for (const poi of dedupedPois) {
    byCategory[poi.category] = (byCategory[poi.category] || 0) + 1;
  }
  console.log('\x1b[36m[GT20 POI Test]\x1b[0m Category breakdown:');
  for (const [cat, cnt] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`   - ${cat.padEnd(20)}: ${cnt}`);
  }

  // Build new GPX with <wpt> for all POIs and <trk> with full original track
  console.log(`\x1b[36m[GT20 POI Test]\x1b[0m Generating GT20_POI.gpx...`);

  const wptLines = dedupedPois.map((poi) => {
    const sym = CATEGORY_TO_SYM[poi.category] || 'Waypoint';
    const name = poi.name ? poi.name.trim() : (poi.category.replace(/_/g, ' '));
    const lines = [
      `  <wpt lat="${poi.lat.toFixed(6)}" lon="${poi.lon.toFixed(6)}">`,
    ];
    if (poi.ele != null && Number.isFinite(poi.ele)) {
      lines.push(`    <ele>${poi.ele.toFixed(1)}</ele>`);
    }
    lines.push(`    <name>${escapeXml(name)}</name>`);
    lines.push(`    <sym>${escapeXml(sym)}</sym>`);
    lines.push(`    <type>${escapeXml(poi.category)}</type>`);
    lines.push(`    <desc>${escapeXml(`[${poi.category}] ${poi.name || ''}`.trim())}</desc>`);
    lines.push(`  </wpt>`);
    return lines.join('\n');
  }).join('\n');

  const trkptLines = points.map((p) => {
    if (p.ele != null && Number.isFinite(p.ele)) {
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>`;
    }
    return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}" />`;
  }).join('\n');

  const gpxContent = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RedView" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>GT20 - avec POI RedView</name>
    <desc>Trace GT20 enrichie de ${dedupedPois.length} POIs dans un rayon de ${RADIUS_M}m via RedView POI VPS</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
${wptLines}
  <trk>
    <name>GT20</name>
    <trkseg>
${trkptLines}
    </trkseg>
  </trk>
</gpx>
`;

  fs.writeFileSync(OUTPUT_GPX_1, gpxContent, 'utf-8');
  console.log(`\x1b[32m✔\x1b[0m Saved: ${OUTPUT_GPX_1} (${(fs.statSync(OUTPUT_GPX_1).size / 1024).toFixed(1)} KB)`);

  fs.writeFileSync(OUTPUT_GPX_2, gpxContent, 'utf-8');
  console.log(`\x1b[32m✔\x1b[0m Saved: ${OUTPUT_GPX_2}`);
}

main().catch((err) => {
  console.error(`\x1b[31m✖ Error: ${err.message}\x1b[0m`);
  console.error(err);
  process.exit(1);
});
