/**
 * Projets de banc construits avec les fonctions de l'app (même chaîne que
 * l'import GPX : normalizeImportedRoutePoints, simplifyPointsByQuality,
 * createImportedTimeline, buildImportedRouteMetrics), sur un tracé
 * synthétique déterministe (marche aléatoire lissée depuis Chamonix, un point
 * tous les ~25 m comme un GPX de compteur), puis rangés comme la prod les
 * stocke (`toProjectDocument` + gzip/base64 de payloadEncoding.ts) : `gz:` dans
 * le document jusqu'à 12 M car., fichier du bucket `project-payloads` au-delà.
 */
import { gzipSync } from 'node:zlib';
import {
  createDefaultItinerary,
  createDefaultProject,
  createImportedPoiState,
  normalizeItineraryProject,
} from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import { extractProjectView, toProjectDocument, type ProjectViewState } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
} from '../../src/features/itineraryPanel/lib/routes/imported-route.ts';
import { simplifyPointsByQuality } from '../../src/features/itineraryPanel/lib/routes/simplify-route.ts';
import { MAX_CLOUD_PROJECT_PAYLOAD_CHARS } from '../../src/shared/utils/projects/limits.ts';
import type { Itinerary, ItineraryProject, TimelineItem } from '../../src/features/itineraryPanel/types/index.ts';
import type { PoiCategory, PoiFeature } from '../../src/features/poi/types.ts';
import type { PredictionResult } from '../../src/features/fitPredictor/types.ts';

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

/** xorshift32 : un LCG `seed * 1103515245` perd sa précision au-delà de 2^53 (cycle court). */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const SURFACES = ['asphalt', 'asphalt', 'asphalt', 'paved', 'gravel', 'dirt', 'unknown'] as const;
const POI_CATEGORIES: PoiCategory[] = [
  'drinking_water', 'toilets', 'supermarket', 'convenience', 'bakery', 'fountain', 'bicycle', 'hospital', 'shower',
];

/** Tracé brut : ~25 m entre points, cap lissé, relief à deux échelles + bruit de GPS. */
function syntheticTrack(km: number, seed: number): RoutePoint[] {
  const rnd = random(seed);
  const points: RoutePoint[] = [];
  let lat = 45.9237 + (rnd() - 0.5) * 0.2;
  let lon = 6.8694 + (rnd() - 0.5) * 0.2;
  let heading = rnd() * Math.PI * 2;
  let turn = 0;
  const steps = Math.ceil((km * 1000) / 25);
  let surface: RoutePoint['surface'] = 'asphalt';
  for (let i = 0; i <= steps; i++) {
    const d = i * 25;
    turn = turn * 0.97 + (rnd() - 0.5) * 0.02;
    heading += turn;
    lat += (25 * Math.cos(heading)) / 111_320;
    lon += (25 * Math.sin(heading)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    if (i % 40 === 0) surface = SURFACES[Math.floor(rnd() * SURFACES.length)];
    const elevationM = 900 + 700 * Math.sin(d / 7_000) + 250 * Math.sin(d / 1_300 + seed) + (rnd() - 0.5) * 2;
    points.push({ lat, lon, elevationM, surface } as RoutePoint);
  }
  return points;
}

function buildPois(points: RoutePoint[], count: number, rnd: () => number): PoiFeature[] {
  return Array.from({ length: count }, (_, i) => {
    const p = points[Math.floor((i / Math.max(1, count)) * (points.length - 1))];
    const category = POI_CATEGORIES[i % POI_CATEGORIES.length];
    const tags: Record<string, string> = { amenity: String(category), name: `POI ${category} ${i}` };
    if (rnd() < 0.6) tags.opening_hours = 'Mo-Sa 07:00-19:30; Su 08:00-12:30';
    if (rnd() < 0.3) tags.website = `https://www.example-${i}.fr/`;
    return {
      id: 100_000_000 + i * 7919,
      lat: p.lat + (rnd() - 0.5) * 0.01,
      lon: p.lon + (rnd() - 0.5) * 0.01,
      category,
      name: tags.name,
      tags,
      osmType: 'node',
      source: null,
      srcConfidence: null,
    } as PoiFeature;
  });
}

/** Prédiction du moteur vélo v2 : un point tous les max(50 m, L/6000), comme cycling/output.rs. */
function buildPrediction(points: RoutePoint[], rnd: () => number): PredictionResult {
  const totalM = points[points.length - 1]?.distanceM ?? 0;
  const n = Math.min(6000, Math.ceil(totalM / 50)) + 1;
  const round = (v: number, step: number) => Math.round(v / step) * step;
  let t = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const src = points[Math.floor((i / (n - 1)) * (points.length - 1))];
    const speed = 18 + rnd() * 12;
    const seg = totalM / n / (speed / 3.6);
    out.push({
      distance_m: round((totalM * i) / (n - 1), 0.1),
      elevation_m: round(src.elevationM ?? 0, 0.1),
      gradient_pct: round((rnd() - 0.5) * 16, 0.01),
      predicted_speed_kmh: round(speed, 0.01),
      predicted_power_w: Math.round(150 + rnd() * 120),
      elapsed_time_s: round(t, 0.1),
      segment_time_s: round(seg, 0.1),
    });
    t += seg;
  }
  return {
    engine_version: 2,
    total_time_s: t,
    riding_time_s: t,
    stop_time_s: 0,
    total_distance_m: totalM,
    avg_speed_kmh: 22,
    elevation_gain_m: 20_000,
    elevation_loss_m: 20_000,
    segments: [],
    points: out,
    discipline: 'bike',
    total_time_low_s: t * 0.92,
    total_time_high_s: t * 1.08,
  } as unknown as PredictionResult;
}

function buildItinerary(index: number, km: number, pois: number, prediction: boolean): Itinerary {
  const rnd = random(1000 + index);
  const stored = normalizeImportedRoutePoints(syntheticTrack(km, 7 + index), { includeGradient: false });
  const simplified = normalizeImportedRoutePoints(simplifyPointsByQuality(stored, 'default'));
  const totalM = stored[stored.length - 1]?.distanceM ?? 0;
  const poiFeatures = buildPois(stored, pois, rnd);
  const favourites = poiFeatures.filter((_, i) => i % 16 === 0).map((poi, i, all) => ({
    id: `poi-${poi.id}`,
    kind: 'poi',
    label: poi.name ?? 'POI',
    distanceKm: Math.round(((i + 1) / (all.length + 1)) * totalM) / 1000,
    durationMin: 10,
    favorite: true,
    visible: true,
    lat: poi.lat,
    lon: poi.lon,
    onRoute: true,
    poiCategory: poi.category,
    osmId: poi.id,
  }) as TimelineItem);
  const name = `Banc ${km} km #${index + 1}`;
  return {
    ...createDefaultItinerary(index),
    id: `it-bench-${index}`,
    name,
    gpxRoute: { name, points: simplified, originalPoints: stored, gpxQuality: 'default', gpxQualityPointsPerKm: null, source: 'gpx' },
    timeline: [...createImportedTimeline(stored), ...favourites],
    metrics: buildImportedRouteMetrics(stored),
    poi: createImportedPoiState(),
    poiFeatures,
    prediction: prediction ? buildPrediction(stored, rnd) : null,
    rhythmConfigured: prediction,
  } as Itinerary;
}

export interface BenchProjectSpec {
  id: string;
  name: string;
  km: number;
  variants: number;
  poisPerVariant: number;
  prediction: boolean;
}

/**
 * Id du document `project_views` (copie de projectViews.ts, dont le module ne
 * se charge pas sous Node) : si elles divergeaient, l'app ne lirait pas la vue
 * semée et le banc le verrait (caméra hors du tracé).
 */
function hash53(value: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function projectViewDocumentId(projectId: string, userId: string): string {
  const key = `${projectId}:${userId}`;
  return `pv${hash53(key, 1).toString(16).padStart(14, '0')}${hash53(key, 2).toString(16).padStart(14, '0')}`;
}

/** Caméra 3D cadrant le tracé du premier itinéraire (vue enregistrée par l'app après un import). */
function routeViewport(project: ItineraryProject) {
  const points = project.itineraries[0]?.gpxRoute?.points ?? [];
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  const lat = (minLat + maxLat) / 2;
  const span = Math.max(maxLon - minLon, (maxLat - minLat) / Math.cos((lat * Math.PI) / 180), 0.01);
  // ~900 px de carte utile, tuiles de 512 px.
  const zoom = Math.min(14, Math.max(3, Math.log2((900 * 360) / (span * 512))));
  return { center: [(minLon + maxLon) / 2, lat] as [number, number], zoom: Math.round(zoom * 100) / 100, pitch: 45, bearing: 0 };
}

export interface BenchProjectRow {
  spec: BenchProjectSpec;
  /** Document `projects` tel que l'app l'écrit. */
  attributes: { user_id: string; folder_id: null; name: string; data: string; size_bytes: number; privacy: 'private' };
  /** Gzip du bucket `project-payloads` quand `data` est un pointeur `file:`. */
  payloadFile: { id: string; bytes: Buffer } | null;
  /** Document `project_views` de l'utilisateur : caméra sur le tracé. */
  view: { id: string; attributes: { project_id: string; user_id: string; data: string } };
  viewport: { center: [number, number]; zoom: number; pitch: number; bearing: number };
  documentChars: number;
  gzipBytes: number;
}

export function buildBenchProject(spec: BenchProjectSpec, userId: string): BenchProjectRow {
  const itineraries = Array.from({ length: spec.variants }, (_, i) => buildItinerary(i, spec.km, spec.poisPerVariant, spec.prediction));
  const base = createDefaultProject();
  const project: ItineraryProject = normalizeItineraryProject({
    ...base,
    name: spec.name,
    itineraries,
    activeItineraryId: itineraries[0].id,
  });
  const json = JSON.stringify(toProjectDocument(project));
  const gzip = gzipSync(Buffer.from(json, 'utf8'));
  const inline = `gz:${gzip.toString('base64')}`;
  const fileId = `${spec.id}payload`;
  const inDocument = inline.length <= MAX_CLOUD_PROJECT_PAYLOAD_CHARS;
  const viewport = routeViewport(project);
  const baseView: ProjectViewState = extractProjectView(project);
  const view: ProjectViewState = { ...baseView, dashboard: { ...(baseView.dashboard ?? {}), mapViewport: viewport } };
  return {
    spec,
    attributes: {
      user_id: userId,
      folder_id: null,
      name: spec.name,
      data: inDocument ? inline : `file:${fileId}`,
      size_bytes: Buffer.byteLength(json, 'utf8'),
      privacy: 'private',
    },
    payloadFile: inDocument ? null : { id: fileId, bytes: gzip },
    view: {
      id: projectViewDocumentId(spec.id, userId),
      attributes: { project_id: spec.id, user_id: userId, data: JSON.stringify({ updatedAt: '2026-10-01T00:00:00.000Z', view }) },
    },
    viewport,
    documentChars: json.length,
    gzipBytes: gzip.length,
  };
}
