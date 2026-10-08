/**
 * Audit B5 — pipeline d'import GPX sur de vrais fichiers (pas de réseau réel :
 * fetch simulé).
 *
 *   npx tsx script-test-bench/audit/b-gpx-import.ts
 *
 * 1. Analyse chaque vrai GPX avec l'analyseur de l'application (parseGpxText —
 *    même code que gpxParseWorker), le chronomètre, rapporte points / km / D+ /
 *    <wpt> présents mais abandonnés par l'import.
 * 2. Exécute les vraies étapes d'enrichissement de l'import qui touchent au
 *    réseau, avec un fetch simulé qui COMPTE les requêtes par hôte :
 *      refineImportedRoutePointsWithIgnAltimetry → data.geopf.fr (France), tuiles
 *                                                  AWS Terrarium ailleurs
 *                                                  (décodeur remplacé sous Node)
 *      analyzeGpxSurfaces                        → /api/brouter (limité en débit
 *                                                  par server.mjs, 120 req/min/IP)
 *    en deux modes : amont en bon état, et /api/brouter qui répond 429 (limite
 *    de débit atteinte).
 *
 * Sortie 1 quand un seul import peut dépasser le budget de 120 req /api par
 * minute, quand le chemin 429 amplifie les requêtes, ou quand quoi que ce soit
 * appelle encore Open-Meteo (API publique : licence non commerciale ;
 * l'altitude vient de l'IGN / de Terrarium).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSrc, closeLoader, DOWNLOADS } from './b-loader';

const FILES = ['GT20.gpx', 'GT20_POI.gpx', 'Tour de France 2026.gpx', 'UTMB 2024.gpx', 'TRAIL DU SANCY 33 km.gpx', 'Les 6 Puys 16 km.gpx', 'route-1.gpx', 'activity_24338087057.gpx'];
const API_BUDGET_PER_MIN = 120;
const failures: string[] = [];

const TERRARIUM_HOST = 's3.amazonaws.com';

/**
 * Le décodage Terrarium a besoin d'OffscreenCanvas + createImageBitmap
 * (navigateur seulement) : remplacé par une tuile plate à 500 m pour que
 * l'import demande vraiment ses tuiles.
 */
function installTerrariumDecoderStub() {
  const g = globalThis as any;
  if (g.OffscreenCanvas) return;
  const encoded = 500 + 32768; // R·256 + G + B/256 − 32768
  g.createImageBitmap = async () => ({ close() {} });
  g.OffscreenCanvas = class {
    getContext() {
      return {
        drawImage() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i++) {
            data[i * 4] = encoded >> 8;
            data[i * 4 + 1] = encoded & 0xff;
            data[i * 4 + 3] = 255;
          }
          return { data };
        },
      };
    }
  };
}

type Mode = 'ok' | '429';
function installMockFetch(mode: Mode) {
  const counts: Record<string, number> = {};
  let inflight = 0, maxInflight = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const host = url.startsWith('/') ? url.split('?')[0] : new URL(url).host;
    counts[host] = (counts[host] ?? 0) + 1;
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 2));
    inflight--;
    if (host.includes('geopf')) {
      const body = JSON.parse(String(init?.body));
      const n = String(body.lon).split('|').length;
      return new Response(JSON.stringify({ elevations: Array.from({ length: n }, () => 500) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (host === TERRARIUM_HOST) {
      return new Response(new Uint8Array(8), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (host === '/api/brouter') {
      if (mode === '429') return new Response(JSON.stringify({ error: 'Trop de requêtes.' }), { status: 429, headers: { 'content-type': 'application/json' } });
      const params = new URL('http://x' + url).searchParams;
      const ll = params.get('lonlats')!.split('|').map((s) => s.split(',').map(Number));
      const header = ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags'];
      const messages = [header, ...ll.map(([lo, la]) => [Math.round(lo * 1e6), Math.round(la * 1e6), 500, 1000, 1000, 0, 0, 0, 0, 'highway=track surface=gravel'])];
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ll }, properties: { 'track-length': '1000', messages } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { counts, get maxInflight() { return maxInflight; }, restore: () => { globalThis.fetch = real; } };
}

async function main() {
  const { parseGpxText } = await loadSrc<any>('src/features/poi/lib/gpx-parse.ts');
  const routes = await loadSrc<any>('src/features/itineraryPanel/lib/routes/index.ts');
  const metrics = await loadSrc<any>('src/features/itineraryPanel/lib/route-metrics/index.ts');

  const parsedAll: Array<{ file: string; points: any[] }> = [];
  console.log('file | bytes | parse ms | pts | km | D+ (import metrics) | <wpt> in file (dropped) | timeline wps');
  for (const f of FILES) {
    const p = path.join(DOWNLOADS, f);
    if (!fs.existsSync(p)) { console.log(`${f}: missing`); continue; }
    const text = fs.readFileSync(p, 'utf8');
    const t0 = performance.now();
    const r = parseGpxText(text);
    const ms = performance.now() - t0;
    const stored = routes.normalizeImportedRoutePoints(r.points, { includeGradient: false });
    const m = routes.buildImportedRouteMetrics(stored);
    const tl = routes.createImportedTimeline(stored);
    const wpt = (text.match(/<wpt\b/g) ?? []).length;
    const noEle = r.points.filter((x: any) => x.elevationM == null).length;
    console.log(`${f} | ${text.length} | ${ms.toFixed(1)} | ${r.points.length} (noEle ${noEle}) | ${m.distanceKm} | ${m.ascentM} | ${wpt} | ${tl.filter((x: any) => x.kind === 'waypoint').length}`);
    parsedAll.push({ file: f, points: stored });
  }
  const wptFiles = FILES.filter((f) => { const p = path.join(DOWNLOADS, f); return fs.existsSync(p) && /<wpt\b/.test(fs.readFileSync(p, 'utf8')); });
  if (wptFiles.length) console.log(`NOTE: <wpt> present in: ${wptFiles.join(', ')}`);

  // B8 — réimporter l'export de RedView lui-même doit garder ses POI (<wpt>).
  const poiExport = path.join(DOWNLOADS, 'GT20_POI.gpx');
  if (fs.existsSync(poiExport)) {
    const { buildImportedGpxWaypoints } = await loadSrc<any>('src/features/itineraryPanel/components/ItineraryPanelContainer/importedGpxWaypoints.ts');
    const text = fs.readFileSync(poiExport, 'utf8');
    const r = parseGpxText(text);
    const wptInFile = (text.match(/<wpt\b/g) ?? []).length;
    const endpoints = (r.waypoints ?? []).filter((w: any) => w.type === 'start' || w.type === 'finish').length;
    const imported = buildImportedGpxWaypoints(r, r.points, 1);
    const favInFile = (text.match(/\(favori\)<\/desc>/g) ?? []).length;
    const favImported = imported.poiFeatures.filter((f: any) => f.favorite).length;
    console.log(`GT20_POI.gpx: <wpt> ${wptInFile} (endpoints ${endpoints}) → parsed ${r.waypoints?.length ?? 0}, imported POIs ${imported.poiFeatures.length} (favorites ${favImported}/${favInFile}), timeline POI rows ${imported.poiRows.length}, waypoint rows ${imported.waypointRows.length}`);
    if (imported.poiFeatures.length + imported.waypointRows.length < wptInFile - endpoints) {
      failures.push(`GT20_POI.gpx: ${wptInFile - endpoints - imported.poiFeatures.length - imported.waypointRows.length} of ${wptInFile - endpoints} <wpt> lost on import`);
    }
    if (favImported !== favInFile) failures.push(`GT20_POI.gpx: favorites ${favImported} != ${favInFile} marked in file`);
  }

  // Route synthétique de 1000 km : concaténer GT20 + UTMB + étape du TdF translatés bout à bout n'est pas
  // réaliste géographiquement ; on densifie plutôt une ligne presque droite de 1000 km à travers la France,
  // avec un espacement de 20 m (export typique).
  const long: any[] = [];
  const N = 50_000; let d = 0;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const lat = 48.85 - 5.5 * t + Math.sin(t * 80) * 0.05, lon = 2.35 + 3.0 * t + Math.cos(t * 60) * 0.05;
    if (i) { const q = long[i - 1]; const r = Math.PI / 180; const h = Math.sin((lat - q.lat) * r / 2) ** 2 + Math.cos(q.lat * r) * Math.cos(lat * r) * Math.sin((lon - q.lon) * r / 2) ** 2; d += 2 * 6371008.8 * Math.asin(Math.sqrt(h)); }
    long.push({ lat, lon, distanceM: d, elevationM: 200 + 300 * Math.sin(t * 30) });
  }
  parsedAll.push({ file: `synthetic ${Math.round(d / 1000)} km / ${N} pts`, points: long });
  // Même ligne déplacée en Italie (Dolomites → Campanie, hors de France) : altitude depuis les tuiles Terrarium, pas l'IGN.
  parsedAll.push({ file: 'synthetic line in Italy (Terrarium)', points: long.map((p) => ({ ...p, lat: p.lat - 2.3, lon: p.lon + 9.4 })) });
  // Longue route à géométrie réelle : le GT20 suivi de l'UTMB, décalé pour être contigu (seul le
  // nombre de morceaux compte ici : il dépend de la longueur et des changements de cap).
  const gt = parsedAll.find((x) => x.file === 'GT20.gpx')?.points, ut = parsedAll.find((x) => x.file === 'UTMB 2024.gpx')?.points;
  if (gt && ut) {
    const last = gt[gt.length - 1], first = ut[0];
    const dLat = last.lat - first.lat, dLon = last.lon - first.lon, off = last.distanceM;
    const joined = [...gt, ...ut.slice(1).map((p: any) => ({ ...p, lat: p.lat + dLat + 0.3, lon: p.lon + dLon, distanceM: p.distanceM + off }))];
    const joined2 = [...joined, ...gt.slice(1).map((p: any) => ({ ...p, lat: p.lat + 1.5, distanceM: p.distanceM + joined[joined.length - 1].distanceM }))];
    parsedAll.push({ file: `GT20+UTMB+GT20 (~${Math.round(joined2[joined2.length - 1].distanceM / 1000)} km real geometry)`, points: joined2 });
  }

  console.log('\nNetwork requests generated by ONE import (mocked fetch):');
  installTerrariumDecoderStub();
  console.log('file | mode | IGN (geopf) | Terrarium tiles | /api/brouter | max concurrent | ms');
  for (const { file, points } of parsedAll) {
    // 429 d'abord : fetchBrouterRoute garde un cache d'URL au niveau du module qui masquerait des requêtes
    for (const mode of ['429', 'ok'] as Mode[]) {
      const mock = installMockFetch(mode);
      const t0 = performance.now();
      try {
        if (mode === 'ok') await routes.refineImportedRoutePointsWithIgnAltimetry(points);
        await metrics.analyzeGpxSurfaces(points);
      } catch (e) { console.log(`  ${file} ${mode}: threw ${(e as Error).message}`); }
      const ms = performance.now() - t0;
      mock.restore();
      const api = mock.counts['/api/brouter'] ?? 0;
      console.log(`${file} | ${mode} | ${mock.counts['data.geopf.fr'] ?? 0} | ${mock.counts[TERRARIUM_HOST] ?? 0} | ${api} | ${mock.maxInflight} | ${ms.toFixed(0)}`);
      const openMeteo = Object.keys(mock.counts).filter((host) => host.includes('open-meteo'));
      if (openMeteo.length) failures.push(`${file}: the import still calls ${openMeteo.join(', ')} (public Open-Meteo API, non-commercial)`);
      if (mode === 'ok' && api + 1 /* corridor de POI */ > API_BUDGET_PER_MIN) failures.push(`${file}: one import issues ${api}+1 /api requests (> ${API_BUDGET_PER_MIN}/min budget)`);
      (globalThis as any).__last = { ...(globalThis as any).__last, [`${file}|${mode}`]: api };
    }
    const okN = (globalThis as any).__last[`${file}|ok`], badN = (globalThis as any).__last[`${file}|429`];
    if (badN > okN * 2) failures.push(`${file}: under 429 the surface analysis amplifies /api/brouter requests ${okN} → ${badN} (recursive split fallback)`);
  }

  console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nOK');
  await closeLoader();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
