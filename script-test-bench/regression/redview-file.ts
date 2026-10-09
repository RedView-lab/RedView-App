/**
 * Fichiers projet `.redview` (src/features/redviewFile) : écriture, lecture,
 * validation. Sortie non nulle au premier échec.
 *
 *  1. Aller-retour complet (projet, .fit, miniature, profils de tracé).
 *  2. Interopérabilité ZIP avec Python `zipfile` dans les deux sens (si Python est installé).
 *  3. Fichiers étrangers, tronqués, altérés, version future, bombe de décompression.
 *  4. Contenu hostile : coordonnées, identifiants, `__proto__`, .fit factices.
 *  5. Repli gzip quand `deflate-raw` manque, noms de fichiers, performance.
 *
 *   npx tsx script-test-bench/regression/redview-file.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultControlPanelPersistedState } from '../../src/features/controlPanel/lib/persistedState.ts';
import {
  createDefaultAnalysisPanelState,
  createDefaultItinerary,
  createDefaultProject,
  normalizeItineraryProject,
} from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import type { SavedCustomProfile } from '../../src/features/itineraryPanel/lib/project/customProfiles.ts';
import type { ItineraryProject } from '../../src/features/itineraryPanel/types/index.ts';
import { withEffectiveControlPanel } from '../../src/features/redviewFile/lib/effectiveControlPanel.ts';
import { RedviewFileError, type RedviewFileErrorKind } from '../../src/features/redviewFile/lib/errors.ts';
import {
  buildRedviewFileName,
  REDVIEW_MIME_TYPE,
  type RedviewContent,
} from '../../src/features/redviewFile/lib/format.ts';
import { buildImportedProjectName } from '../../src/features/redviewFile/lib/naming.ts';
import { readRedviewFile } from '../../src/features/redviewFile/lib/readRedviewFile.ts';
import { writeRedviewFile } from '../../src/features/redviewFile/lib/writeRedviewFile.ts';
import { crc32 } from '../../src/features/redviewFile/lib/zip/crc32.ts';
import { deflateRaw, wrapRawDeflateInGzip } from '../../src/features/redviewFile/lib/zip/deflate.ts';
import { writeZip } from '../../src/features/redviewFile/lib/zip/zipWriter.ts';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    failures += 1;
    process.exitCode = 1;
    return;
  }
  console.log(`✅ PASSED: ${message}`);
}

async function expectError(promise: Promise<unknown>, kind: RedviewFileErrorKind, message: string): Promise<void> {
  try {
    await promise;
    assert(false, `${message} (aucune erreur levée)`);
  } catch (error) {
    const actual = error instanceof RedviewFileError ? error.kind : String(error);
    assert(actual === kind, `${message} → ${kind}${actual === kind ? '' : ` (reçu : ${actual})`}`);
  }
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text) as Uint8Array<ArrayBuffer>;

/** .fit synthétique valide pour `validateFitHeader` : en-tête 14 octets, données, CRC. */
function syntheticFit(dataSize: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(14 + dataSize + 2);
  const view = new DataView(out.buffer);
  out[0] = 14;
  out[1] = 0x20;
  view.setUint16(2, 2132, true);
  view.setUint32(4, dataSize, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  let x = seed;
  for (let i = 14; i < 14 + dataSize; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    // Records FIT : beaucoup de répétitions, donc compressibles.
    out[i] = i % 16 < 10 ? (x >>> 24) & 0x0f : i & 0xff;
  }
  return out;
}

function syntheticPng(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(512);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < out.length; i++) out[i] = (i * 31) & 0xff;
  return out;
}

function buildProject(pointCount: number): ItineraryProject {
  const project = createDefaultProject();
  const a = createDefaultItinerary(1);
  a.id = 'it-a';
  a.name = 'Chamonix → Paris';
  a.profileId = 'custom_123';
  a.gpxRoute = {
    name: 'chamonix-paris',
    source: 'brouter',
    points: Array.from({ length: pointCount }, (_, i) => ({
      lat: 45.92 + i * 1e-4,
      lon: 6.87 - i * 1e-4,
      distanceM: i * 10,
      elevationM: 1035 + Math.sin(i / 50) * 120,
      gradientPct: Math.cos(i / 50) * 4,
      surface: 'asphalt' as const,
    })),
  };
  a.timeline = [
    { id: 'start', kind: 'start', label: 'Chamonix', distanceKm: 0, lat: 45.92, lon: 6.87 },
    { id: 'end', kind: 'end', label: 'Paris', distanceKm: pointCount / 100, lat: 48.85, lon: 2.35 },
  ];
  a.prediction = { total_time_s: 75_000, riding_time_s: 70_000, stop_time_s: 5_000, total_distance_m: pointCount * 10 } as never;
  a.poiFeatures = [{ id: 42, lat: 46.1, lon: 6.5, category: 'drinking_water', name: 'Fontaine <b>', tags: { amenity: 'drinking_water' } }];
  a.forbiddenZones = [{ id: 'z1', createdAt: '2026-10-01T10:00:00.000Z', points: [{ lat: 46, lon: 6 }, { lat: 46.1, lon: 6 }, { lat: 46.1, lon: 6.1 }] }];
  a.fitUploads = [
    { name: 'sortie-1.fit', type: 'application/octet-stream', lastModified: 1_700_000_000_000, size: 1, path: 'bucket-file-id-1' },
    { name: 'sortie-2.fit', type: 'application/octet-stream', lastModified: 1_700_000_100_000, size: 1, path: 'bucket-file-id-2' },
  ];
  const b = createDefaultItinerary(2);
  b.id = 'it-b';
  b.name = 'Variante';
  project.name = 'GT20 « été » 2026';
  project.privacy = 'public';
  project.savedAt = '2026-10-01T10:00:00.000Z';
  project.itineraries = [a, b];
  project.activeItineraryId = 'it-b';
  project.activeMode = 'rythme';
  project.dashboard = { leftPanelWidth: 420, mapViewport: { center: [6.87, 45.92], zoom: 11.5, pitch: 60, bearing: -20 } };
  (project as unknown as Record<string, unknown>).futureField = { kept: true };
  return project;
}

/** Projet où chaque champ persisté est renseigné (valeurs non par défaut). */
function buildFullProject(): ItineraryProject {
  const project = buildProject(500);
  const a = project.itineraries[0]!;
  a.name = '  Itinéraire  avec espaces ';
  a.color = 'rgb(10, 20, 30)';
  a.discipline = 'bike';
  a.visible = false;
  a.analysisVisible = false;
  a.renderMode = 'slope';
  a.opacity = 70;
  a.rhythm = { ...a.rhythm, startDate: '2026-07-14', startTime: '05:45', rhythmProfile: 'custom', ftp: 280, systemWeightKg: 84, pauseAtFavoritePois: true };
  a.rhythmConfigured = true;
  a.pendingFitRecompute = true;
  a.metrics = { distanceKm: 5, durationSec: 81_234, ascentM: 1234, descentM: 1200, avgSlopePercent: 4.2, tarmacPercent: 80, offroadPercent: 20 };
  a.gpxRoute = {
    ...a.gpxRoute!,
    points: a.gpxRoute!.points.map((point, i) => ({ ...point, roughness: 1 + (i % 4), wayCode: i % 7 })),
    originalPoints: a.gpxRoute!.points.slice(0, 50),
    gpxQuality: 'balanced',
    gpxQualityPointsPerKm: 12,
    routedInputsKey: 'inputs-signature',
  };
  a.timeline = [
    { id: 'start', kind: 'start', label: ' Chamonix ', distanceKm: 0, lat: 45.92, lon: 6.87 },
    { id: 'wp1', kind: 'waypoint', label: 'Col', distanceKm: 1.2, lat: 45.95, lon: 6.8, favorite: true, onRoute: true },
    { id: 'poi1', kind: 'poi', label: 'Fontaine', distanceKm: 2.5, lat: 46, lon: 6.7, favorite: true, poiCategory: 'fountains', osmId: 123, favoriteSource: 'manual' },
    { id: 'pause1', kind: 'pause', label: 'Pause', distanceKm: 3, durationMin: 25 },
    { id: 'end', kind: 'end', label: 'Arrivée', distanceKm: 5, lat: 46.1, lon: 6.6 },
  ] as ItineraryProject['itineraries'][number]['timeline'];
  a.prediction = {
    total_time_s: 81_234,
    riding_time_s: 75_000,
    stop_time_s: 6_234,
    total_distance_m: 5_000,
    avg_speed_kmh: 24.1,
    elevation_gain_m: 1234,
    elevation_loss_m: 1200,
    segments: [{ start_km: 0, end_km: 5, time_s: 75_000 }],
    points: [{ d: 0, t: 0 }, { d: 2500, t: 37_000 }, { d: 5000, t: 75_000 }],
    engine: 'cycling',
    engine_version: 4,
  } as never;
  a.poiFeatures = [
    { id: 42, lat: 46.1, lon: 6.5, category: 'drinking_water', name: 'Fontaine', tags: { amenity: 'drinking_water' }, favorite: true, pauseDurationMin: 15, osmType: 'node', source: null, srcConfidence: null, favoriteSource: 'manual' },
    { id: 43, lat: 46.2, lon: 6.4, category: 'bakeries', name: null, tags: {}, autoReason: 'water' } as never,
  ];
  a.poiSearchSignature = 'poi-search';
  a.poiRouteSignature = 'poi-route';
  a.poiAutoSortEnabled = true;
  a.poiAutoSort = { signature: 'sort', summary: { kept: 3 } as never, picks: [{ osmId: 43 }] as never, ranAt: '2026-10-04T10:00:00.000Z' };
  a.routeAudit = { visible: true, findings: [{ id: 'f1', kind: 'steep', title: 'Raide', detail: '18 %', coordinates: [[6.8, 45.9], [6.81, 45.91]] }] };
  a.steepAlertOverrides = { 'k-1': { kind: 'warning', ignored: true } };
  a.expertProfile = { ...a.expertProfile!, enabled: true };
  a.pendingTraceExtension = { from: { lat: 46, lon: 6 }, to: { lat: 46.1, lon: 6.1 } };
  a.pendingRoutePatch = {
    start: { lat: 46, lon: 6, kind: 'waypoint', distanceM: 1000 },
    end: { lat: 46.1, lon: 6.1, kind: 'end' },
    via: [{ lat: 46.05, lon: 6.05 }],
  };
  const b = project.itineraries[1]!;
  b.prediction = null;
  b.splitRelation = { parentItineraryId: 'it-a', rootItineraryId: 'it-a', startDistanceKm: 2.5, depth: 1 };
  project.name = '  GT20 « été »  ';
  project.activeMode = 'poi';
  project.timelineView = 'timeline';
  project.analysis = { ...createDefaultAnalysisPanelState(), xMode: 'heure', axis2: 'Vitesse', axis1Color: '#ff0000', surfaceFilter: 'gravel', detailZoom: 2, detailOffset: 0.3 };
  project.controlPanel = {
    ...createDefaultControlPanelPersistedState(),
    basemapId: 'outdoor' as never,
    toggles: { ...createDefaultControlPanelPersistedState().toggles, slopesEnabled: true, contourLinesEnabled: true },
    lidarTilesHidden: { '0965_6500_2154': true },
  };
  project.dashboard = { rightPanelWidth: 380, leftPanelWidth: 420, centerPanelHeight: 300, lidarDownloadModeEnabled: false, mapViewport: { center: [6.87, 45.92], zoom: 11.5, pitch: 60, bearing: -20 } };
  return project;
}

/** Chemin du premier écart entre deux valeurs JSON (ordre des clés ignoré), sinon null. */
function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: tableau ≠ objet`;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)].filter((key) => ra[key] !== undefined || rb[key] !== undefined));
  for (const key of keys) {
    const found = firstDifference(ra[key], rb[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

const PROFILE: SavedCustomProfile = {
  id: 'custom_123',
  name: 'Gravel roulant',
  basePresetId: 'gravel-default',
  roadTypes: { activityType: 'gravel-default' } as SavedCustomProfile['roadTypes'],
  priorities: { comfort: 60 } as unknown as SavedCustomProfile['priorities'],
  createdAt: 1_700_000_000_000,
};

function buildContent(pointCount = 2_000): RedviewContent {
  return {
    project: buildProject(pointCount),
    fitFiles: [
      { itineraryId: 'it-a', index: 0, name: 'sortie-1.fit', type: 'application/octet-stream', lastModified: 1_700_000_000_000, data: syntheticFit(200_000, 1) },
      { itineraryId: 'it-a', index: 1, name: 'sortie-2.fit', type: 'application/octet-stream', lastModified: 1_700_000_100_000, data: syntheticFit(50_000, 2) },
    ],
    routingProfiles: [PROFILE],
    thumbnail: { mime: 'image/png', data: syntheticPng() },
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function blobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Offset et longueurs d'une entrée d'après son en-tête local (recherche par nom). */
function findLocalEntry(zip: Uint8Array, name: string): { dataStart: number; compressedSize: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = 0;
  while (p + 30 <= zip.length && view.getUint32(p, true) === 0x04034b50) {
    const compressedSize = view.getUint32(p + 18, true);
    const nameLength = view.getUint16(p + 26, true);
    const extraLength = view.getUint16(p + 28, true);
    const entryName = new TextDecoder().decode(zip.subarray(p + 30, p + 30 + nameLength));
    const dataStart = p + 30 + nameLength + extraLength;
    if (entryName === name) return { dataStart, compressedSize };
    p = dataStart + compressedSize;
  }
  throw new Error(`entry ${name} not found`);
}

function findPython(): string | null {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import zipfile, sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'redview-test-'));
  try {
    console.log('\n--- 1. Aller-retour complet ---');
    const content = buildContent();
    const blob = await writeRedviewFile(content, { build: 'test-build', createdAt: new Date('2026-10-04T12:00:00Z') });
    const zip = await blobBytes(blob);
    assert(blob.type === REDVIEW_MIME_TYPE, 'type MIME du Blob');
    assert(new TextDecoder().decode(zip.subarray(30, 38)) === 'mimetype', 'première entrée « mimetype » (octet 30)');
    assert(new TextDecoder().decode(zip.subarray(38, 38 + REDVIEW_MIME_TYPE.length)) === REDVIEW_MIME_TYPE, 'type lisible à l’octet 38 (entrée stockée)');

    const read = await readRedviewFile(blob);
    const a = read.project.itineraries.find((it) => it.id === 'it-a');
    const source = content.project.itineraries[0]!;
    assert(read.project.name === 'GT20 « été » 2026', 'nom du projet (UTF-8)');
    assert(read.project.itineraries.length === 2, 'deux itinéraires');
    assert(read.project.activeItineraryId === 'it-b' && read.project.activeMode === 'rythme', 'itinéraire et mode actifs');
    assert(a?.gpxRoute?.points.length === source.gpxRoute!.points.length, 'nombre de points du tracé');
    assert(JSON.stringify(a?.gpxRoute?.points) === JSON.stringify(source.gpxRoute!.points), 'points du tracé identiques (lat, lon, altitude, pente, surface)');
    assert(JSON.stringify(a?.timeline) === JSON.stringify(source.timeline), 'feuille de route identique');
    assert(a?.prediction?.total_time_s === 75_000, 'prédiction conservée');
    assert(a?.poiFeatures?.[0]?.name === 'Fontaine <b>', 'POI conservés (texte brut, non interprété)');
    assert(a?.forbiddenZones?.length === 1, 'zones interdites conservées');
    assert(a?.profileId === 'custom_123', 'profil de tracé référencé');
    assert(JSON.stringify(read.project.dashboard?.mapViewport) === JSON.stringify(content.project.dashboard?.mapViewport), 'vue carte conservée');
    assert(read.project.dashboard?.leftPanelWidth === 420, 'largeur de panneau conservée');
    assert((read.project as unknown as Record<string, unknown>).futureField != null, 'champ inconnu (version future compatible) conservé');
    assert(read.project.privacy === 'private' && read.project.savedAt === null, 'confidentialité et horodatage de l’expéditeur retirés');
    assert(JSON.stringify(read.project).includes('bucket-file-id') === false, 'aucune référence au bucket de l’expéditeur');
    assert(read.fitFiles.length === 2 && read.skippedFitFiles === 0, 'deux .fit relus');
    assert(read.fitFiles.every((fit, i) => fit.itineraryId === 'it-a' && fit.index === i && equalBytes(fit.data, content.fitFiles[i]!.data)), '.fit identiques octet pour octet, dans l’ordre');
    assert(read.fitFiles[1]?.name === 'sortie-2.fit' && read.fitFiles[1]?.lastModified === 1_700_000_100_000, 'métadonnées des .fit');
    assert(read.thumbnail?.mime === 'image/png' && equalBytes(read.thumbnail.data, content.thumbnail!.data), 'miniature identique');
    assert(read.routingProfiles.length === 1 && read.routingProfiles[0]!.name === 'Gravel roulant', 'profil de tracé perso');
    assert(read.manifest.generator.build === 'test-build' && read.manifest.formatVersion === 1, 'manifeste (build, version)');
    const fitRaw = content.fitFiles.reduce((sum, fit) => sum + fit.data.byteLength, 0);
    console.log(`   taille : ${(blob.size / 1024).toFixed(0)} Ko (.fit bruts ${(fitRaw / 1024).toFixed(0)} Ko + projet ${(JSON.stringify(content.project).length / 1024).toFixed(0)} Ko)`);

    console.log('\n--- 1b. Projet complet : identité champ par champ ---');
    const full = buildFullProject();
    const fullRead = await readRedviewFile(await writeRedviewFile({
      project: full,
      fitFiles: [{ itineraryId: 'it-a', index: 0, name: 'sortie-1.fit', type: 'application/octet-stream', lastModified: 1_700_000_000_000, data: syntheticFit(1_000, 5) }],
      routingProfiles: [],
      thumbnail: null,
    }));
    // Seuls changements voulus : confidentialité et horodatage de l'expéditeur,
    // `fitUploads` reconstruits à l'import depuis les .fit embarqués.
    const expected = normalizeItineraryProject({
      ...full,
      privacy: 'private',
      savedAt: null,
      sizeBytes: null,
      itineraries: full.itineraries.map((itinerary) => {
        const copy = { ...itinerary };
        delete copy.fitUploads;
        return copy;
      }),
    });
    const diff = firstDifference(expected, fullRead.project);
    assert(diff === null, `projet relu identique, hors confidentialité / horodatage${diff ? ` — écart : ${diff}` : ''}`);
    const it = fullRead.project.itineraries[0]!;
    assert(it.timeline.filter((row) => row.favorite).length === 2, 'favoris de la feuille de route (POI + waypoint)');
    assert(it.poiFeatures?.filter((poi) => poi.favorite).length === 1 && it.poiFeatures[0]!.pauseDurationMin === 15, 'POI favoris et durée de pause sur la carte');
    assert(it.prediction?.total_time_s === 81_234 && it.prediction.points.length === 3, 'prédiction complète (durées, points)');
    assert(it.color === 'rgb(10, 20, 30)' && it.name === '  Itinéraire  avec espaces ', 'couleur rgb() et nom avec espaces gardés tels quels');
    assert(fullRead.project.itineraries[1]?.prediction === null, 'prédiction effacée (null) gardée distincte d’une prédiction absente');
    assert(fullRead.fitFiles.length === 1, '.fit rattaché à son itinéraire');

    console.log('\n--- 1c. Réglages de calques lus dans les préférences du navigateur ---');
    const bare = buildProject(10);
    bare.controlPanel = {
      ...createDefaultControlPanelPersistedState(),
      toggles: { ...createDefaultControlPanelPersistedState().toggles, slopesEnabled: true },
    };
    const frozen = withEffectiveControlPanel(bare).controlPanel!;
    assert(frozen.slopes?.state.enabled === true && frozen.slopes.scaleSetting === '10 couleurs', 'pentes figées dans le fichier (valeurs initiales du panneau, interrupteur du projet)');
    assert(frozen.altitude != null && frozen.labelsState != null, 'altitude et étiquettes figées');
    const complete = buildFullProject();
    complete.controlPanel = frozen;
    assert(withEffectiveControlPanel(complete) === complete, 'projet déjà complet : rien n’est touché');

    console.log('\n--- 2. Interopérabilité ZIP (Python zipfile) ---');
    const python = findPython();
    if (!python) {
      console.log('   ⚠️  Python 3 introuvable : vérification croisée ignorée');
    } else {
      const ours = join(workDir, 'ours.redview');
      const theirs = join(workDir, 'theirs.redview');
      writeFileSync(ours, zip);
      const script = join(workDir, 'interop.py');
      writeFileSync(script, [
        'import json, sys, zipfile',
        'ours, theirs = sys.argv[1], sys.argv[2]',
        'z = zipfile.ZipFile(ours)',
        'bad = z.testzip()',
        'names = z.namelist()',
        'manifest = json.loads(z.read("manifest.json"))',
        'project = json.loads(z.read("project.json"))',
        'print(json.dumps({"bad": bad, "names": names, "fit": len(manifest["fitFiles"]), "points": len(project["itineraries"][0]["gpxRoute"]["points"])}))',
        '# Fichier écrit par un ZIP standard (deflate, mimetype stocké), relu par RedView.',
        'out = zipfile.ZipFile(theirs, "w")',
        'for info in z.infolist():',
        '    method = zipfile.ZIP_STORED if info.filename in ("mimetype", "thumbnail.png") else zipfile.ZIP_DEFLATED',
        '    out.writestr(zipfile.ZipInfo(info.filename, date_time=(2026, 10, 4, 12, 0, 0)), z.read(info.filename), compress_type=method)',
        'out.close()',
      ].join('\n'));
      const run = spawnSync(python, [script, ours, theirs], { encoding: 'utf8' });
      if (run.status !== 0) {
        assert(false, `Python a relu le fichier : ${run.stderr.trim()}`);
      } else {
        const report = JSON.parse(run.stdout.trim()) as { bad: string | null; names: string[]; fit: number; points: number };
        assert(report.bad === null, 'zipfile.testzip() : tous les CRC valides');
        assert(report.names[0] === 'mimetype' && report.names.includes('fit/1.fit') && report.names.includes('thumbnail.png'), `entrées lues par Python : ${report.names.join(', ')}`);
        assert(report.fit === 2 && report.points === 2_000, 'JSON lisible par un outil tiers');
        const foreign = await readRedviewFile(new Blob([readFileSync(theirs)]));
        assert(foreign.fitFiles.length === 2 && equalBytes(foreign.fitFiles[0]!.data, content.fitFiles[0]!.data), 'archive écrite par Python relue par RedView');
      }
    }

    console.log('\n--- 3. Fichiers étrangers, tronqués, altérés ---');
    await expectError(readRedviewFile(new Blob([bytes('<?xml version="1.0"?><gpx></gpx>')])), 'not-redview', 'fichier GPX');
    await expectError(readRedviewFile(new Blob([])), 'not-redview', 'fichier vide');
    const plainZip = await writeZip([{ name: 'readme.txt', data: bytes('hello') }]);
    await expectError(readRedviewFile(plainZip), 'not-redview', 'ZIP quelconque sans « mimetype »');
    const otherMime = await writeZip([{ name: 'mimetype', data: bytes('application/epub+zip'), compress: false }]);
    await expectError(readRedviewFile(otherMime), 'not-redview', 'autre format ZIP (EPUB)');
    await expectError(readRedviewFile(new Blob([zip.slice(0, Math.floor(zip.length * 0.6))])), 'corrupted', 'fichier tronqué à 60 %');
    await expectError(readRedviewFile(new Blob([zip.slice(0, zip.length - 10)])), 'corrupted', 'fin de répertoire tronquée');

    const flipped = zip.slice();
    const projectEntry = findLocalEntry(flipped, 'project.json');
    flipped[projectEntry.dataStart + Math.floor(projectEntry.compressedSize / 2)]! ^= 0x5a;
    await expectError(readRedviewFile(new Blob([flipped])), 'corrupted', 'octet altéré dans project.json (deflate / CRC)');

    const flippedFit = zip.slice();
    const fitEntry = findLocalEntry(flippedFit, 'fit/2.fit');
    flippedFit[fitEntry.dataStart + fitEntry.compressedSize - 3]! ^= 0x01;
    await expectError(readRedviewFile(new Blob([flippedFit])), 'corrupted', 'octet altéré dans un .fit');

    const future = await writeZip([
      { name: 'mimetype', data: bytes(REDVIEW_MIME_TYPE), compress: false },
      { name: 'manifest.json', data: bytes(JSON.stringify({ format: 'redview.project', formatVersion: 7, minReaderVersion: 5, fitFiles: [] })) },
      { name: 'project.json', data: bytes('{"itineraries":[]}') },
    ]);
    await expectError(readRedviewFile(future), 'newer-version', 'fichier d’une version future (minReaderVersion 5)');
    const compatibleFuture = await writeZip([
      { name: 'mimetype', data: bytes(REDVIEW_MIME_TYPE), compress: false },
      { name: 'manifest.json', data: bytes(JSON.stringify({ format: 'redview.project', formatVersion: 3, minReaderVersion: 1, fitFiles: [], newThing: {} })) },
      { name: 'project.json', data: bytes(JSON.stringify({ name: 'Futur', itineraries: [], newProjectThing: 1 })) },
    ]);
    const compatible = await readRedviewFile(compatibleFuture);
    assert(compatible.project.name === 'Futur', 'version future compatible (minReaderVersion 1) acceptée');

    // Bombe : 64 Mo de zéros annoncés comme 100 octets.
    const zeros = new Uint8Array(64 * 1024 * 1024) as Uint8Array<ArrayBuffer>;
    const bomb = await blobBytes(await writeZip([
      { name: 'mimetype', data: bytes(REDVIEW_MIME_TYPE), compress: false },
      { name: 'manifest.json', data: bytes(JSON.stringify({ format: 'redview.project', formatVersion: 1, minReaderVersion: 1, fitFiles: [] })) },
      { name: 'project.json', data: zeros },
    ]));
    const bombView = new DataView(bomb.buffer);
    const bombEntry = findLocalEntry(bomb, 'project.json');
    const localHeader = bombEntry.dataStart - 30 - 'project.json'.length;
    bombView.setUint32(localHeader + 22, 100, true);
    for (let p = bomb.length - 22; p > 0; p--) {
      if (bombView.getUint32(p, true) !== 0x02014b50) continue;
      const nameLength = bombView.getUint16(p + 28, true);
      if (new TextDecoder().decode(bomb.subarray(p + 46, p + 46 + nameLength)) === 'project.json') {
        bombView.setUint32(p + 24, 100, true);
        break;
      }
    }
    const bombStart = performance.now();
    await expectError(readRedviewFile(new Blob([bomb])), 'corrupted', `bombe de décompression (${(bomb.length / 1024).toFixed(0)} Ko → 64 Mo annoncés 100 o) arrêtée`);
    assert(performance.now() - bombStart < 2_000, 'arrêt immédiat de la bombe (< 2 s)');

    const hugeDeclared = await blobBytes(await writeZip([
      { name: 'mimetype', data: bytes(REDVIEW_MIME_TYPE), compress: false },
      { name: 'manifest.json', data: zeros.subarray(0, 3 * 1024 * 1024) as Uint8Array<ArrayBuffer> },
    ]));
    await expectError(readRedviewFile(new Blob([hugeDeclared])), 'too-large', 'manifeste au-delà de sa limite');

    console.log('\n--- 4. Contenu hostile ---');
    const hostile = async (project: unknown, extra: Partial<{ manifest: Record<string, unknown>; entries: Array<{ name: string; data: Uint8Array<ArrayBuffer> }> }> = {}) =>
      writeZip([
        { name: 'mimetype', data: bytes(REDVIEW_MIME_TYPE), compress: false },
        { name: 'manifest.json', data: bytes(JSON.stringify({ format: 'redview.project', formatVersion: 1, minReaderVersion: 1, fitFiles: [], ...extra.manifest })) },
        { name: 'project.json', data: bytes(typeof project === 'string' ? project : JSON.stringify(project)) },
        ...(extra.entries ?? []),
      ]);
    await expectError(readRedviewFile(await hostile({ foo: 1 })), 'invalid-project', 'project.json sans itinéraires');
    await expectError(readRedviewFile(await hostile('{"itineraries": [')), 'corrupted', 'project.json non JSON');
    const badPoint = buildProject(10);
    badPoint.itineraries[0]!.gpxRoute!.points[3]!.lat = 999;
    await expectError(readRedviewFile(await hostile(badPoint)), 'invalid-project', 'latitude hors limites');
    const dupIds = buildProject(10);
    dupIds.itineraries[1]!.id = dupIds.itineraries[0]!.id;
    await expectError(readRedviewFile(await hostile(dupIds)), 'invalid-project', 'identifiants d’itinéraire en double');
    const noTimeline = buildProject(10) as unknown as { itineraries: Array<Record<string, unknown>> };
    noTimeline.itineraries[0]!.timeline = 'nope';
    await expectError(readRedviewFile(await hostile(noTimeline)), 'invalid-project', 'feuille de route invalide');

    const proto = await readRedviewFile(await hostile('{"name":"P","itineraries":[],"__proto__":{"polluted":true},"controlPanel":{"__proto__":{"x":1}}}'));
    assert(Object.getPrototypeOf(proto.project) === Object.prototype && !('polluted' in proto.project), 'clé __proto__ retirée');
    assert(({} as Record<string, unknown>).polluted === undefined, 'aucune pollution du prototype global');

    const messy = buildProject(10) as unknown as { itineraries: Array<Record<string, unknown>> } & Record<string, unknown>;
    messy.itineraries[0]!.color = 'red; background:url(javascript:alert(1))';
    messy.itineraries[0]!.poiFeatures = [{ id: 1, lat: 'x', lon: 2, category: 'bars' }, { id: 2, lat: 46, lon: 6, category: 'bars', name: 'ok' }];
    messy.itineraries[0]!.forbiddenZones = [{ id: 'z', points: [{ lat: 1 }] }];
    messy.dashboard = { mapViewport: { center: ['a', 2], zoom: 3, pitch: 0, bearing: 0 }, leftPanelWidth: 'wide' };
    messy.activeMode = 'hack';
    const messyPoints = (messy.itineraries[0]!.gpxRoute as { points: Array<Record<string, unknown>> }).points;
    messyPoints[0]!.elevationM = 'abc';
    messyPoints[1]!.distanceM = { x: 1 };
    const cleaned = await readRedviewFile(await hostile(messy));
    const first = cleaned.project.itineraries[0]!;
    assert(/^#[0-9a-f]{6}$/i.test(first.color), `couleur invalide remplacée (${first.color})`);
    assert(first.poiFeatures?.length === 1, 'POI aux coordonnées invalides écartés');
    assert((first.forbiddenZones ?? []).length === 0, 'zone interdite invalide écartée');
    assert(cleaned.project.dashboard?.mapViewport === undefined && cleaned.project.dashboard?.leftPanelWidth === undefined, 'vue carte / largeurs invalides retirées');
    assert(cleaned.project.activeMode === 'tracage', 'mode actif inconnu ramené à « tracage »');
    const cleanedPoints = first.gpxRoute!.points;
    assert(cleanedPoints[0]!.elevationM === undefined && cleanedPoints[1]!.distanceM === undefined, 'altitude / distance non numériques retirées des points');
    assert(cleanedPoints[2]!.elevationM === messyPoints[2]!.elevationM, 'altitude valide gardée intacte');

    const fakeFit = await readRedviewFile(await hostile(buildProject(10), {
      manifest: {
        fitFiles: [
          { entry: 'fit/1.fit', itineraryId: 'it-a', index: 0, name: 'evil.fit' },
          { entry: 'fit/2.fit', itineraryId: 'it-ghost', index: 0, name: 'orphan.fit' },
          { entry: '../../etc/passwd', itineraryId: 'it-a', index: 1, name: 'x.fit' },
          { entry: 'fit/3.fit', itineraryId: 'it-a', index: 2, name: 'ok.fit' },
        ],
      },
      entries: [
        { name: 'fit/1.fit', data: bytes('<script>alert(1)</script> not a fit file at all') },
        { name: 'fit/2.fit', data: syntheticFit(100, 3) },
        { name: 'fit/3.fit', data: syntheticFit(100, 4) },
      ],
    }));
    assert(fakeFit.fitFiles.length === 1 && fakeFit.fitFiles[0]!.name === 'ok.fit', '.fit factice, orphelin et chemin hors fit/ écartés');
    assert(fakeFit.skippedFitFiles === 3, 'trois .fit signalés comme écartés');

    const fakeThumb = await readRedviewFile(await hostile(buildProject(10), {
      manifest: { thumbnail: { entry: 'thumbnail.png', mime: 'image/png' } },
      entries: [{ name: 'thumbnail.png', data: bytes('<svg onload="alert(1)"></svg>') }],
    }));
    assert(fakeThumb.thumbnail === null, 'miniature qui n’est pas une image reconnue ignorée');

    console.log('\n--- 5. Repli gzip, noms, performance ---');
    const sample = syntheticFit(300_000, 9);
    const raw = await deflateRaw(sample);
    const viaGzip = new Uint8Array(await new Response(
      wrapRawDeflateInGzip(new Blob([raw]), crc32(sample), sample.length).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer());
    assert(equalBytes(viaGzip, sample), 'lecture deflate via l’enveloppe gzip (navigateurs sans deflate-raw)');

    assert(buildRedviewFileName('GT20 « été » 2026') === 'GT20 « été » 2026.redview', 'nom de fichier lisible (accents, espaces)');
    assert(buildRedviewFileName('a/b\\c:d*e?f"g<h>i|j') === 'a b c d e f g h i j.redview', 'caractères interdits remplacés');
    assert(buildRedviewFileName('   ...  ') === 'projet.redview', 'nom vide → « projet »');
    assert(buildRedviewFileName('CON') === 'CON-projet.redview', 'nom réservé Windows évité');
    assert(buildRedviewFileName('x'.repeat(300)).length === 120 + '.redview'.length, 'nom tronqué à 120 caractères');
    assert(buildImportedProjectName('Tour', ['tour']) === 'Tour (importé)', 'nom d’import déjà pris → « (importé) »');
    assert(buildImportedProjectName('Tour', ['tour', 'Tour (importé)']) === 'Tour (importé 2)', 'nom d’import libre dans le dossier (jamais « (2) », affiché ② par la police)');
    assert(buildImportedProjectName('Tour', ['Autre']) === 'Tour', 'nom d’import gardé s’il est libre');

    const big = buildContent(200_000);
    const writeStart = performance.now();
    const bigBlob = await writeRedviewFile(big);
    const writeMs = performance.now() - writeStart;
    const readStart = performance.now();
    const bigRead = await readRedviewFile(bigBlob);
    const readMs = performance.now() - readStart;
    const jsonMb = JSON.stringify(big.project).length / 1024 / 1024;
    console.log(`   projet 200 000 points (${jsonMb.toFixed(1)} Mo de JSON) : fichier ${(bigBlob.size / 1024 / 1024).toFixed(1)} Mo, écriture ${writeMs.toFixed(0)} ms, lecture ${readMs.toFixed(0)} ms`);
    assert(bigRead.project.itineraries[0]!.gpxRoute!.points.length === 200_000, 'gros projet relu en entier');
    assert(writeMs < 5_000 && readMs < 5_000, 'gros projet : écriture et lecture < 5 s');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n✅ Tous les tests .redview passent.' : `\n❌ ${failures} échec(s).`);
}

void main();
