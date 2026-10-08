/**
 * Audit D / LIDAR — sonde en direct de la découverte et du téléchargement
 * LiDAR HD de l'IGN (data.geopf.fr), qui rejoue exactement ce que fait
 * src/features/lidar/lib/wfsClient.ts, puis fait un HEAD sur le fichier résolu
 * (sans télécharger le corps).
 *
 *   npx tsx script-test-bench/audit/d-lidar-ign-live.ts [--lon=5.7245 --lat=45.1885]
 *
 * Budget réseau : au plus 3 pages de flux + au plus 4 requêtes HEAD, espacées d'1 s.
 * Code de sortie 1 si la résolution de l'application échouait, ou si la liste
 * codée en dur FALLBACK_ZONES de wfsClient.ts a dérivé du flux réel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toWgs84, buildTileFileName, wgs84ToTileCoord } from '../../src/features/lidar/lib/coordConvert.ts';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as const;
}));
const LON = Number(args.get('lon') ?? 5.7245);
const LAT = Number(args.get('lat') ?? 45.1885);
const IGN_DL_BASE = 'https://data.geopf.fr/telechargement';
const ORIGIN = 'https://app.redview.tech';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Zone = { name: string; bbox: { west: number; south: number; east: number; north: number }; date: string };

// Même logique que wfsClient.ts:95-133 (DOMParser remplacé par une regex sous Node).
function parseZones(xml: string): Zone[] {
  const stripped = xml.replace(/<georss:polygon>[\s\S]*?<\/georss:polygon>/g, '').replace(/<georss:polygon\/>/g, '');
  const zones: Zone[] = [];
  for (const m of stripped.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)) {
    const entry = m[0];
    const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const bboxStr = entry.match(/gpf_dl:bbox="([^"]+)"/)?.[1];
    if (!title || !bboxStr) continue;
    const p = bboxStr.trim().split(/\s+/).map(Number);
    if (p.length < 4 || p.some(Number.isNaN)) continue;
    zones.push({ name: title, bbox: { west: p[0], south: p[1], east: p[2], north: p[3] }, date: title.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? '2000-01-01' });
  }
  return zones;
}

let bugs = 0;
async function main() {
  const coord = wgs84ToTileCoord(LON, LAT);
  console.log(`point ${LON},${LAT} -> tile ${JSON.stringify(coord)}`);
  if (coord.projection !== 'LAMB93') throw new Error('choose a point in mainland France');

  const zones: Zone[] = [];
  let maxPages = 1;
  let firstHeaders: Headers | null = null;
  for (let page = 1; page <= maxPages && page <= 6; page++) {
    const t0 = performance.now();
    const res = await fetch(`${IGN_DL_BASE}/resource/LiDARHD-NUALID?limit=100&page=${page}`, { headers: { Origin: ORIGIN } });
    const text = await res.text();
    console.log(`feed page ${page}: HTTP ${res.status} ${(text.length / 1024).toFixed(0)} KB in ${(performance.now() - t0).toFixed(0)} ms`);
    if (page === 1) {
      firstHeaders = res.headers;
      const pc = text.match(/gpf_dl:pagecount="(\d+)"/)?.[1];
      if (pc) maxPages = parseInt(pc, 10) || 1;
    }
    zones.push(...parseZones(text));
    await pause(1000);
  }
  console.log(`feed: pagecount=${maxPages}, zones parsed=${zones.length}, ACAO=${firstHeaders?.get('access-control-allow-origin')}`);

  // Dérive de la liste de repli
  const src = fs.readFileSync(path.resolve('src/features/lidar/lib/wfsClient.ts'), 'utf8');
  const fallbackCodes = [...src.matchAll(/'([A-Z]{2,3}_\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
  const liveCodes = new Set(zones.map((z) => z.name.replace(/^NUALHD_1-0__LAZ_[A-Z0-9]+_/, '')));
  const stale = fallbackCodes.filter((c) => !liveCodes.has(c));
  const missing = [...liveCodes].filter((c) => !fallbackCodes.includes(c));
  console.log(`fallback list: ${fallbackCodes.length} codes; ${stale.length} not in live feed; live feed has ${missing.length} codes absent from fallback`);
  if (stale.length) console.log(`  stale sample: ${stale.slice(0, 8).join(', ')}`);
  if (missing.length) console.log(`  missing sample: ${missing.slice(0, 8).join(', ')}`);
  if (zones.length && (stale.length || missing.length)) bugs++;

  // Même appariement que resolveDownloadUrls (wfsClient.ts:198-250)
  const [lon, lat] = toWgs84(coord.xKm * 1000 + 500, coord.yKm * 1000 + 500, coord.projection);
  const matching = zones.filter((z) => lon >= z.bbox.west && lon <= z.bbox.east && lat >= z.bbox.south && lat <= z.bbox.north);
  console.log(`tile centre ${lon.toFixed(5)},${lat.toFixed(5)} matches ${matching.length} zone(s): ${matching.map((z) => z.name).join(', ')}`);
  const sample = zones[0];
  if (sample) console.log(`bbox axis sanity: ${sample.name} bbox=${JSON.stringify(sample.bbox)} (expects lon in west/east, lat in south/north)`);
  const baseName = buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef);
  const urls: string[] = [];
  for (const z of matching) urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${z.name}/${baseName}.copc.laz`, `${IGN_DL_BASE}/download/LiDARHD-NUALID/${z.name}/${baseName}.laz`);

  let found = false;
  for (const url of urls.slice(0, 2)) {
    await pause(1000);
    const t0 = performance.now();
    const res = await fetch(url, { headers: { Origin: ORIGIN, Range: 'bytes=0-3' }, redirect: 'manual' });
    const h = res.headers;
    console.log(`GET[0-3] ${url.replace(IGN_DL_BASE, '')}\n  -> ${res.status} in ${(performance.now() - t0).toFixed(0)} ms, size=${h.get('content-length')} B `
      + `(${(Number(h.get('content-length') ?? 0) / 1048576).toFixed(1)} MB), type=${h.get('content-type')}, accept-ranges=${h.get('accept-ranges')}, `
      + `ACAO=${h.get('access-control-allow-origin')}, ACEH=${h.get('access-control-expose-headers')}, location=${h.get('location')}`);
    const body = new Uint8Array(await res.arrayBuffer());
    console.log(`  content-range=${h.get('content-range')} body=${res.status < 300 ? Buffer.from(body).toString('latin1') : Buffer.from(body).toString('utf8').slice(0, 200)}`);
    if (res.status === 200 || res.status === 206) { found = true; break; }
  }
  if (!found) { console.log('BUG: no candidate URL resolved to a file'); bugs++; }
  process.exit(bugs);
}

main().catch((e) => { console.error(e); process.exit(99); });
