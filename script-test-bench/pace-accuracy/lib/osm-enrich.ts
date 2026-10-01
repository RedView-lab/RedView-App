/**
 * Enrichissement OSM des sorties de référence via BRouter (réseau, mis en cache).
 *
 * Chaque trace FIT est re-routée par BRouter avec un point de passage tous les
 * 500 m (requêtes de 16 points, limite de l'app), ce qui donne :
 *  - les tags de voie le long de la trace (revêtement, rugosité, type de voie,
 *    agglomération, feux) reportés sur chaque point FIT à moins de 25 m ;
 *  - une route « planifiée » (géométrie OSM, altitude BRouter) pour le mode B.
 *
 * Upstream : le proxy public de l'app (`/api/brouter`, le VPS refuse les accès
 * directs), requêtes espacées de 3,2 s (limite partagée 120 req/min/IP) ;
 * surcharge par PACE_BROUTER (base contenant `/brouter`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { engineCodesFromTags } from '../../../src/features/itineraryPanel/lib/route-metrics/engineCodes.ts';
import { haversineM, type Ride } from './rides';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
const CACHE_DIR = path.join(ROOT, 'script-test-bench/pace-accuracy/.cache');
const VIA_EVERY_M = 500;
const POINTS_PER_REQUEST = 16;
const MATCH_RADIUS_M = 25;

export interface PlannedRoute {
  lat: number[];
  lon: number[];
  ele: number[];
  dist: number[];
  surface: number[];
  way: number[];
}

export interface OsmEnrichment {
  /** Codes moteur reportés sur chaque point de la trace FIT (0 = non apparié). */
  trackSurface: number[];
  trackWay: number[];
  /** Part de la trace appariée à moins de 25 m. */
  matchedShare: number;
  planned: PlannedRoute;
}

const MIN_GAP_MS = 3200;
let lastRequest = 0;

function brouterEndpoint(): string {
  return (process.env.PACE_BROUTER ?? 'https://app.redview.tech/api/brouter').replace(/\/+$/, '');
}

interface LegResult { coords: [number, number, number][]; rows: { lon: number; lat: number; dist: number; wayTags: string; nodeTags: string }[] }

async function fetchLeg(endpoint: string, pts: { lat: number; lon: number }[]): Promise<LegResult> {
  const lonlats = pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url = `${endpoint}?lonlats=${lonlats}&profile=trekking&alternativeidx=0&format=geojson`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastRequest + MIN_GAP_MS * (attempt + 1) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      const feat = json.features?.[0];
      const messages: unknown[][] = feat?.properties?.messages ?? [];
      const header = (messages[0] ?? []).map(String);
      const ix = (name: string) => header.indexOf(name);
      const rows = messages.slice(1).map((r) => ({
        lon: Number(r[ix('Longitude')]) / 1e6,
        lat: Number(r[ix('Latitude')]) / 1e6,
        dist: Number(r[ix('Distance')]),
        wayTags: String(r[ix('WayTags')] ?? ''),
        nodeTags: ix('NodeTags') >= 0 ? String(r[ix('NodeTags')] ?? '') : '',
      }));
      return { coords: feat?.geometry?.coordinates ?? [], rows };
    }
    console.warn(`  BRouter ${res.status} (essai ${attempt + 1}/3) : ${(await res.text()).slice(0, 120)}`);
  }
  throw new Error(`BRouter en échec sur ${pts.length} points`);
}

/** Route planifiée avec codes par point, à partir des tronçons BRouter. */
function assemble(legs: LegResult[]): PlannedRoute {
  const out: PlannedRoute = { lat: [], lon: [], ele: [], dist: [], surface: [], way: [] };
  let dTotal = 0;
  for (const leg of legs) {
    // Étendues de tags : chaque ligne de messages termine un tronçon de `dist` m.
    const spans: { end: number; surface: number; way: number; endLat: number; endLon: number; signal: boolean }[] = [];
    let acc = 0;
    for (const row of leg.rows) {
      acc += Number.isFinite(row.dist) ? row.dist : 0;
      const codes = engineCodesFromTags(row.wayTags, row.nodeTags);
      spans.push({ end: acc, surface: codes.surface, way: codes.way & 0x7f, endLat: row.lat, endLon: row.lon, signal: (codes.way & 0x80) !== 0 });
    }
    const geomLen = leg.coords.reduce((s, c, i) => (i === 0 ? 0 : s + haversineM(leg.coords[i - 1]![1], leg.coords[i - 1]![0], c[1], c[0])), 0);
    const scale = acc > 0 && geomLen > 0 ? acc / geomLen : 1;
    let local = 0;
    let si = 0;
    for (let i = 0; i < leg.coords.length; i++) {
      const c = leg.coords[i]!;
      if (i > 0) local += haversineM(leg.coords[i - 1]![1], leg.coords[i - 1]![0], c[1], c[0]);
      if (out.lat.length > 0 && i === 0) continue; // point de jonction déjà présent
      while (si < spans.length - 1 && spans[si]!.end < local * scale - 0.5) si++;
      const span = spans[si];
      let way = span?.way ?? 0;
      if (span?.signal && haversineM(c[1], c[0], span.endLat, span.endLon) < 3) way |= 0x80;
      const step = out.lat.length > 0 ? haversineM(out.lat[out.lat.length - 1]!, out.lon[out.lon.length - 1]!, c[1], c[0]) : 0;
      dTotal += step;
      out.lat.push(c[1]);
      out.lon.push(c[0]);
      out.ele.push(c[2] ?? NaN);
      out.dist.push(dTotal);
      out.surface.push(span?.surface ?? 0);
      out.way.push(way);
    }
  }
  return out;
}

/** Report des codes de la route planifiée sur la trace FIT (curseur monotone). */
function transfer(ride: Ride, planned: PlannedRoute): { surface: number[]; way: number[]; matched: number } {
  const n = planned.lat.length;
  const surface: number[] = [];
  const way: number[] = [];
  let cursor = 0;
  let matched = 0;
  for (const p of ride.track) {
    let best = Infinity;
    let bestJ = cursor;
    const from = Math.max(0, cursor - 20);
    for (let j = from; j < Math.min(n, cursor + 400); j++) {
      const dd = haversineM(p.lat, p.lon, planned.lat[j]!, planned.lon[j]!);
      if (dd < best) { best = dd; bestJ = j; }
    }
    // Distance au segment [bestJ, bestJ+1] plutôt qu'au sommet seul.
    if (bestJ + 1 < n) {
      const a = { lat: planned.lat[bestJ]!, lon: planned.lon[bestJ]! };
      const b = { lat: planned.lat[bestJ + 1]!, lon: planned.lon[bestJ + 1]! };
      const ky = 111_195;
      const kx = ky * Math.cos((p.lat * Math.PI) / 180);
      const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky;
      const px = (p.lon - a.lon) * kx, py = (p.lat - a.lat) * ky;
      const len2 = bx * bx + by * by;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
        best = Math.min(best, Math.hypot(px - t * bx, py - t * by));
      }
    }
    if (best <= MATCH_RADIUS_M) {
      matched++;
      cursor = bestJ;
      surface.push(planned.surface[bestJ]!);
      way.push(planned.way[bestJ]!);
    } else {
      surface.push(0);
      way.push(0);
    }
  }
  return { surface, way, matched: matched / ride.track.length };
}

export async function enrichRide(ride: Ride, opts: { refresh?: boolean } = {}): Promise<OsmEnrichment> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `osm-${ride.id}.json`);
  if (!opts.refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  const endpoint = brouterEndpoint();
  const vias: { lat: number; lon: number }[] = [];
  let next = 0;
  for (const p of ride.track) {
    if (p.d >= next) { vias.push({ lat: p.lat, lon: p.lon }); next = p.d + VIA_EVERY_M; }
  }
  const last = ride.track[ride.track.length - 1]!;
  vias.push({ lat: last.lat, lon: last.lon });

  const legs: LegResult[] = [];
  for (let i = 0; i < vias.length - 1; i += POINTS_PER_REQUEST - 1) {
    const chunk = vias.slice(i, i + POINTS_PER_REQUEST);
    if (chunk.length < 2) break;
    legs.push(await fetchLeg(endpoint, chunk));
  }
  const planned = assemble(legs);
  const t = transfer(ride, planned);
  const result: OsmEnrichment = { trackSurface: t.surface, trackWay: t.way, matchedShare: t.matched, planned };
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}
