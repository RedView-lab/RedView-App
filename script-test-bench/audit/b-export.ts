/**
 * Audit B6 — export (GPX / KML / FIT) sur une vraie longue route.
 *
 *   npx tsx script-test-bench/audit/b-export.ts
 *
 * - Importe « Tour de France 2026.gpx » avec le vrai analyseur de
 *   l'application + la normalisation d'import, ajoute N ancres de POI, lance
 *   les vrais exporteurs.
 * - Redécode le FIT avec le Decoder de @garmin/fitsdk : intégrité, erreurs, et
 *   vérifie que les positions des record / course-point tombent sur la route
 *   (FIT stocke les positions en *semicercles* : deg * 2^31 / 180).
 * - Vérifie que le GPX / KML est bien formé (appariement des balises par
 *   pile) et fait faire un aller-retour au GPX dans l'analyseur de
 *   l'application.
 * - Chronomètre collectExportAnchors / buildItineraryFitCourse avec beaucoup
 *   d'ancres (estimateAnchorElevation et findNearestRecordMessage sont en
 *   O(ancres×points)).
 *
 * Code de sortie 1 quand un défaut se reproduit (positions FIT hors route, XML mal formé…).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';
import { loadSrc, closeLoader, DOWNLOADS } from './b-loader';

const GPX_FILE = path.join(DOWNLOADS, 'Tour de France 2026.gpx');
const failures: string[] = [];

function wellFormed(xml: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(xml))) {
    const text = xml.slice(lastIndex, m.index);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) return `bare & in text near ${m.index}`;
    if (/</.test(text)) return `stray < near ${m.index}`;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return `illegal control char near ${m.index}`;
    lastIndex = re.lastIndex;
    if (!m[2]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) return `mismatched </${m[2]}> (open ${open}) at ${m.index}`;
    } else if (!m[4]) stack.push(m[2]);
  }
  return stack.length ? `unclosed ${stack.join(',')}` : null;
}

async function main() {
  const { parseGpxText } = await loadSrc<any>('src/features/poi/lib/gpx-parse.ts');
  const routes = await loadSrc<any>('src/features/itineraryPanel/lib/routes/index.ts');
  const { buildItineraryGpx, buildItineraryKml, buildItineraryFitCourse } =
    await loadSrc<any>('src/features/exporter/lib/itinerary-export.ts');
  const { collectExportAnchors, getExportRoutePoints } =
    await loadSrc<any>('src/features/exporter/lib/exportHelpers.ts');

  const text = fs.readFileSync(GPX_FILE, 'utf8');
  const parsed = parseGpxText(text);
  const stored = routes.normalizeImportedRoutePoints(parsed.points, { includeGradient: false });
  const timeline = routes.createImportedTimeline(stored);
  const totalKm = stored[stored.length - 1].distanceM / 1000;
  console.log(`route: ${stored.length} pts, ${totalKm.toFixed(1)} km, timeline rows ${timeline.length}`);

  const makeItinerary = (nPoi: number) => {
    const poiFeatures = Array.from({ length: nPoi }, (_, i) => {
      const p = stored[Math.floor((i / nPoi) * (stored.length - 1))];
      return { id: 1e9 + i, lat: p.lat + 0.0005, lon: p.lon + 0.0005, name: `POI ${i} <&> "q"`, category: 'water', favorite: true, tags: {} };
    });
    return {
      id: 'it-1', name: 'TdF', discipline: 'road', timeline,
      gpxRoute: { name: parsed.name, points: stored, originalPoints: stored, source: 'gpx', gpxQuality: 'default', gpxQualityPointsPerKm: null },
      poiFeatures,
    };
  };

  // --- FIT ---------------------------------------------------------------
  const it200 = makeItinerary(200);
  let t0 = performance.now();
  const fit = buildItineraryFitCourse(it200) as Uint8Array;
  const fitMs = performance.now() - t0;
  const stream = Stream.fromByteArray(Array.from(fit));
  const decoder = new Decoder(stream);
  const isFit = decoder.isFIT();
  const integrity = decoder.checkIntegrity();
  const { messages, errors } = decoder.read();
  const recs = messages.recordMesgs ?? [];
  const cps = messages.coursePointMesgs ?? [];
  console.log(`FIT: ${fit.byteLength} B in ${fitMs.toFixed(0)} ms, isFIT=${isFit} integrity=${integrity} errors=${errors.length} records=${recs.length} coursePoints=${cps.length}`);
  const r0 = recs[0];
  const SEMI = 2 ** 31 / 180;
  console.log(`  first record raw positionLat=${r0?.positionLat} positionLong=${r0?.positionLong} | source deg=${stored[0].lat.toFixed(5)},${stored[0].lon.toFixed(5)} | expected semicircles=${Math.round(stored[0].lat * SEMI)}`);
  console.log(`  first record altitude=${r0?.altitude} distance=${r0?.distance}; last distance=${recs[recs.length - 1]?.distance}`);
  if (!isFit || !integrity || errors.length) failures.push(`FIT decode problem: isFIT=${isFit} integrity=${integrity} errors=${errors.length}`);
  if (recs.length !== stored.length) failures.push(`FIT record count ${recs.length} != ${stored.length}`);
  const latDeg = Number(r0?.positionLat ?? 0) / SEMI;
  if (Math.abs(latDeg - stored[0].lat) > 0.001) {
    failures.push(`FIT positions not in semicircles: decoded ${latDeg.toFixed(6)}° vs route ${stored[0].lat.toFixed(6)}° (course would sit at ~0°N 0°E)`);
  }

  // --- GPX ---------------------------------------------------------------
  t0 = performance.now();
  const gpx = buildItineraryGpx(it200) as string;
  const gpxMs = performance.now() - t0;
  const gpxErr = wellFormed(gpx);
  const re = parseGpxText(gpx);
  console.log(`GPX: ${(gpx.length / 1024).toFixed(0)} KB in ${gpxMs.toFixed(0)} ms, well-formed=${gpxErr ?? 'yes'}, reparsed pts=${re.points.length}, wpt=${(gpx.match(/<wpt /g) ?? []).length}`);
  if (gpxErr) failures.push(`GPX malformed: ${gpxErr}`);
  if (re.points.length !== stored.length) failures.push(`GPX round-trip point count ${re.points.length} != ${stored.length}`);

  // Caractères de contrôle dans un libellé (p. ex. nom de POI collé) → XML 1.0 invalide
  const itCtl = makeItinerary(1);
  (itCtl.poiFeatures[0] as any).name = 'Fontaine\u0007 du col';
  const gpxCtl = buildItineraryGpx(itCtl) as string;
  const ctlErr = wellFormed(gpxCtl);
  console.log(`GPX with control char in POI name: well-formed=${ctlErr ?? 'yes'}`);
  if (ctlErr) failures.push(`GPX with control char in name is invalid XML 1.0 (${ctlErr})`);

  // --- KML ---------------------------------------------------------------
  t0 = performance.now();
  const kml = buildItineraryKml(it200) as string;
  const kmlMs = performance.now() - t0;
  const kmlErr = wellFormed(kml);
  console.log(`KML: ${(kml.length / 1024).toFixed(0)} KB in ${kmlMs.toFixed(0)} ms, well-formed=${kmlErr ?? 'yes'}`);
  if (kmlErr) failures.push(`KML malformed: ${kmlErr}`);

  // --- passage à l'échelle ancres × points --------------------------------
  const routePoints = getExportRoutePoints(makeItinerary(0));
  for (const n of [100, 1000, 5000]) {
    const it = makeItinerary(n);
    t0 = performance.now();
    collectExportAnchors(it, routePoints);
    const anchorsMs = performance.now() - t0;
    t0 = performance.now();
    buildItineraryFitCourse(it);
    const fitN = performance.now() - t0;
    console.log(`anchors=${n}: collectExportAnchors ${anchorsMs.toFixed(0)} ms, full FIT ${fitN.toFixed(0)} ms (route ${routePoints.length} pts)`);
  }

  console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nOK');
  await closeLoader();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
