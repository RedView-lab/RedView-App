import { Decoder, Stream } from '@garmin/fitsdk';
import { describe, expect, it } from 'vitest';

import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary, PoiCategory, TimelineItem } from '@/features/itineraryPanel/types';
import type { PoiFeature } from '@/features/poi/types';

import { buildItineraryFitCourse } from './exportFit';
import { buildItineraryGpx } from './exportGpx';
import { countExportPois, type ExportOptions } from './exportHelpers';

const CATEGORIES: PoiCategory[] = [
  'fountains', 'toilets', 'supermarkets', 'gasStations', 'bakeries', 'fastFood', 'cafes', 'bars',
  'restaurants', 'bikeShops', 'hotels', 'refuges', 'passes', 'health', 'transport',
];

function itineraryWithEveryPoiCategory(): Itinerary {
  const points = Array.from({ length: 400 }, (_, i) => ({
    lat: 45.9 + i * 0.0005,
    lon: 6.87,
    elevationM: 1000 + i,
    distanceM: i * 55.6,
  }));
  const at = (i: number) => points[i]!;
  return {
    id: 'it',
    name: 'Tour du Mont-Blanc',
    discipline: 'road',
    gpxRoute: { name: 'Tour du Mont-Blanc', points },
    poiFeatures: [],
    timeline: [
      { id: 'start', label: 'Départ', kind: 'start', lat: at(0).lat, lon: at(0).lon, distanceKm: 0 },
      ...CATEGORIES.map((poiCategory, k) => {
        const p = at(20 + k * 20);
        return { id: `poi-${k}`, label: poiCategory, kind: 'poi', poiCategory, osmId: 100 + k, lat: p.lat, lon: p.lon, distanceKm: p.distanceM / 1000, visible: true, favorite: true };
      }),
      { id: 'end', label: 'Arrivée', kind: 'end', lat: at(399).lat, lon: at(399).lon, distanceKm: at(399).distanceM / 1000 },
    ],
  } as unknown as Itinerary;
}

function decode(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  return messages;
}

describe('buildItineraryFitCourse', () => {
  it('exports a course point for every POI category (valid FIT course point types)', () => {
    // « health » était exporté en « first_aid », absent du profil FIT : l'export échouait.
    const bytes = buildItineraryFitCourse(itineraryWithEveryPoiCategory());
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
    expect(bytes.length).toBeGreaterThan(400 * 17);
    const points = decode(bytes).coursePointMesgs ?? [];
    expect(points).toHaveLength(CATEGORIES.length);
    expect(points.every((point) => point.type !== 'generic')).toBe(true);
  });
});

// ── Parcours d'un ultra : trace plein nord, POI de part et d'autre ────────

/** Trace plein nord : un POI à l'est est à droite, à l'ouest à gauche. */
const LAT0 = 45.9;
const LON0 = 6.87;
const STEP_DEG = 0.0005;
const POINTS = 400;
const METERS_PER_DEG_LAT = 110_540;
const metersPerDegLon = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

const routePoints = Array.from({ length: POINTS }, (_, i) => ({
  lat: LAT0 + i * STEP_DEG,
  lon: LON0,
  elevationM: 500 + i,
  distanceM: i * STEP_DEG * METERS_PER_DEG_LAT,
}));
const TOTAL_M = routePoints[POINTS - 1]!.distanceM;

interface PoiSpec {
  id: number;
  category: PoiFeature['category'];
  panel: PoiCategory;
  at: number;
  /** Mètres vers l'est (> 0, à droite) ou l'ouest (< 0, à gauche). */
  eastM: number;
  name?: string | null;
  tags?: Record<string, string>;
  row?: Partial<TimelineItem>;
}

const POI_LABEL_FR: Partial<Record<PoiFeature['category'], string>> = {
  fountain: 'Fontaine',
  supermarket: 'Supermarché',
  toilets: 'Toilettes',
  pharmacy: 'Pharmacie',
};

function ultraItinerary(specs: PoiSpec[], extraRows: TimelineItem[] = [], extra: Partial<Itinerary> = {}): Itinerary {
  const features: PoiFeature[] = specs.map((spec) => ({
    id: spec.id,
    lat: routePoints[spec.at]!.lat,
    lon: LON0 + spec.eastM / metersPerDegLon,
    category: spec.category,
    name: spec.name ?? null,
    tags: spec.tags ?? {},
  }));
  const rows: TimelineItem[] = specs.map((spec, index) => ({
    id: `poi-${spec.id}`,
    kind: 'poi',
    label: spec.name ?? POI_LABEL_FR[spec.category] ?? 'POI',
    distanceKm: routePoints[spec.at]!.distanceM / 1000,
    lat: features[index]!.lat,
    lon: features[index]!.lon,
    poiCategory: spec.panel,
    osmId: spec.id,
    visible: true,
    ...spec.row,
  }));
  const timeline = [
    { id: 'start', kind: 'start', label: 'Départ', lat: LAT0, lon: LON0, distanceKm: 0 },
    ...rows,
    ...extraRows,
    { id: 'end', kind: 'end', label: 'Arrivée', lat: routePoints[POINTS - 1]!.lat, lon: LON0, distanceKm: TOTAL_M / 1000 },
  ].sort((l, r) => (l.kind === 'start' ? -1 : r.kind === 'start' ? 1 : (l.distanceKm ?? 0) - (r.distanceKm ?? 0)));
  return {
    id: 'ultra',
    name: 'Ultra',
    discipline: 'road',
    // Lundi 12 octobre 2026, départ 6 h.
    rhythm: { startDate: '2026-10-12', startTime: '06:00' },
    gpxRoute: { name: 'Ultra', points: routePoints },
    poiFeatures: features,
    timeline,
    ...extra,
  } as unknown as Itinerary;
}

/** Une heure de roulage pour toute la trace. */
const ONE_HOUR: PredictionResult = {
  total_time_s: 3600,
  total_distance_m: TOTAL_M,
  points: [
    { distance_m: 0, elapsed_time_s: 0 },
    { distance_m: TOTAL_M, elapsed_time_s: 3600 },
  ],
} as unknown as PredictionResult;

const FR: ExportOptions = { locale: 'fr', prediction: ONE_HOUR };

const ULTRA_POIS: PoiSpec[] = [
  { id: 1, category: 'fountain', panel: 'fountains', at: 40, eastM: -10 },
  { id: 2, category: 'bakery', panel: 'bakeries', at: 100, eastM: 3, name: 'La Mie Câline', tags: { opening_hours: 'Mo-Su 07:00-19:00' } },
  // Fermée le lundi : jour du passage.
  { id: 3, category: 'bakery', panel: 'bakeries', at: 120, eastM: -6, name: 'Chez Paul', tags: { opening_hours: 'Tu-Su 07:00-13:00' } },
  { id: 4, category: 'supermarket', panel: 'supermarkets', at: 150, eastM: 20, tags: { brand: 'Carrefour Contact' } },
  { id: 5, category: 'hotel', panel: 'hotels', at: 200, eastM: -11, name: 'Hôtel de la Gare', row: { favorite: true } },
  { id: 6, category: 'toilets', panel: 'toilets', at: 250, eastM: 8, row: { label: 'Cimetière', labelEdited: true } },
  { id: 7, category: 'camp_site', panel: 'hotels', at: 300, eastM: 30, name: 'Camping du Lac', row: { visible: false } },
  { id: 8, category: 'pharmacy', panel: 'health', at: 350, eastM: 15, name: 'Pharmacie du Centre', tags: { opening_hours: 'Mo-Fr 08:30-12:00,14:00-19:30' } },
];

const ZONZA: TimelineItem = {
  id: 'wpt-zonza',
  kind: 'waypoint',
  label: 'Zonza',
  lat: routePoints[180]!.lat,
  lon: LON0,
  distanceKm: routePoints[180]!.distanceM / 1000,
};

describe('export FIT pour les pros : convention de nommage, icônes, horaires', () => {
  const messages = decode(buildItineraryFitCourse(ultraItinerary(ULTRA_POIS, [ZONZA]), FR));
  const points = messages.coursePointMesgs ?? [];
  const byName = new Map(points.map((point) => [point.name as string, point]));

  it('chaque POI de la feuille de route, nommé CAT_CDD[_horaires][_nom]', () => {
    expect(points.map((point) => point.name)).toEqual([
      'EAU_G10',
      'BOU_D03_7-19_La Mie Câline',
      'BOU_G06_fermé_Chez Paul',
      'SUP_D20_Carrefour Contact',
      'Zonza',
      'HOT_G11_Hôtel de la Gare',
      'TOI_D08_Cimetière',
      // Camping masqué (œil) : absent.
      'PHA_D15_8.30-12,14-19.30_Pharmacie du Centre',
    ]);
  });

  it('type Garmin selon la catégorie (icône du compteur), étape = checkpoint', () => {
    expect(byName.get('EAU_G10')?.type).toBe('water');
    expect(byName.get('BOU_D03_7-19_La Mie Câline')?.type).toBe('food');
    expect(byName.get('SUP_D20_Carrefour Contact')?.type).toBe('store');
    expect(byName.get('HOT_G11_Hôtel de la Gare')?.type).toBe('shelter');
    expect(byName.get('TOI_D08_Cimetière')?.type).toBe('toilet');
    expect(byName.get('PHA_D15_8.30-12,14-19.30_Pharmacie du Centre')?.type).toBe('firstAid');
    expect(byName.get('Zonza')?.type).toBe('checkpoint');
  });

  it('points de parcours sur la trace, dans l’ordre, au bon kilomètre', () => {
    const distances = points.map((point) => point.distance as number);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(byName.get('EAU_G10')?.distance).toBeCloseTo(routePoints[40]!.distanceM, 0);
  });

  it('horodatage = départ du Rythme + prédiction : le compteur affiche la durée prévue', () => {
    const records = messages.recordMesgs ?? [];
    const first = records[0]!.timestamp as Date;
    const last = records[records.length - 1]!.timestamp as Date;
    expect(first.getTime()).toBe(new Date(2026, 9, 12, 6, 0).getTime());
    expect((last.getTime() - first.getTime()) / 1000).toBe(3600);
    const lap = messages.lapMesgs?.[0];
    expect(lap?.totalTimerTime).toBe(3600);
    expect(lap?.totalElapsedTime).toBe(3600);
    expect(lap?.totalDistance).toBeCloseTo(TOTAL_M, 0);
    // Horodatages jamais décroissants.
    for (let i = 1; i < records.length; i++) {
      expect((records[i]!.timestamp as Date).getTime()).toBeGreaterThanOrEqual((records[i - 1]!.timestamp as Date).getTime());
    }
  });

  it('le parcours annonce position, distance et temps', () => {
    const course = messages.courseMesgs?.[0];
    expect(course?.sport).toBe('cycling');
    expect(course?.capabilities).toBeDefined();
  });

  it('messages dans l’ordre des parcours Komoot / Garmin Connect : points de parcours mêlés à la trace', () => {
    const stream: Array<{ num: number; message: Record<string, unknown> }> = [];
    const decoder = new Decoder(Stream.fromByteArray(Array.from(buildItineraryFitCourse(ultraItinerary(ULTRA_POIS, [ZONZA]), FR))));
    decoder.read({ mesgListener: (num: number, message: Record<string, unknown>) => stream.push({ num, message }) });
    const RECORD = 20;
    const COURSE_POINT = 32;
    // file_id, course, lap, départ du chrono, …, arrêt du chrono.
    expect(stream.slice(0, 4).map((entry) => entry.num)).toEqual([0, 31, 19, 21]);
    expect(stream[3]!.message.eventType).toBe('start');
    expect(stream.at(-1)!.num).toBe(21);
    expect(stream.at(-1)!.message.eventType).toBe('stopDisableAll');

    const coursePoints = stream.flatMap((entry, index) => (entry.num === COURSE_POINT ? [index] : []));
    expect(coursePoints).toHaveLength(points.length);
    for (const index of coursePoints) {
      // Juste après le point de la trace où il se trouve (ou un autre point de parcours au même endroit).
      let previous = index - 1;
      while (stream[previous]!.num === COURSE_POINT) previous -= 1;
      expect(stream[previous]!.num).toBe(RECORD);
      expect(stream[previous]!.message.distance).toBe(stream[index]!.message.distance);
      expect((stream[previous]!.message.timestamp as Date).getTime()).toBe((stream[index]!.message.timestamp as Date).getTime());
    }
    expect(coursePoints.map((index) => stream[index]!.message.messageIndex)).toEqual(points.map((_, k) => k));

    const timestamps = stream.slice(3).map((entry) => (entry.message.timestamp as Date).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });
});

describe('export FIT : pauses, langue, périmètre', () => {
  it('les pauses planifiées allongent la durée du parcours, comme l’agenda', () => {
    const pause: TimelineItem = { id: 'pause-1', kind: 'pause', label: 'Pause', distanceKm: TOTAL_M / 2000, durationMin: 30 };
    const messages = decode(buildItineraryFitCourse(ultraItinerary([], [pause]), FR));
    expect(messages.lapMesgs?.[0]?.totalTimerTime).toBe(3600 + 30 * 60);
  });

  it('en anglais : codes et côtés L / R', () => {
    const messages = decode(buildItineraryFitCourse(ultraItinerary(ULTRA_POIS.slice(0, 3)), { ...FR, locale: 'en' }));
    expect((messages.coursePointMesgs ?? []).map((point) => point.name)).toEqual([
      'WAT_L10',
      'BAK_R03_7-19_La Mie Câline',
      'BAK_L06_closed_Chez Paul',
    ]);
  });

  it('favoris seulement, tous, ou aucun POI', () => {
    const itinerary = ultraItinerary(ULTRA_POIS, [ZONZA]);
    const names = (options: ExportOptions) =>
      (decode(buildItineraryFitCourse(itinerary, { ...FR, ...options })).coursePointMesgs ?? []).map((point) => point.name);
    expect(names({ pois: 'favorites' })).toEqual(['Zonza', 'HOT_G11_Hôtel de la Gare']);
    expect(names({ pois: 'none' })).toEqual(['Zonza']);
    expect(names({ pois: 'all' })).toContain('CAM_D30_Camping du Lac');
    expect(countExportPois(itinerary)).toEqual({ roadbook: 7, favorites: 1, all: 8 });
  });

  it('tri auto actif : la feuille de route ne garde que les POI retenus et les favoris', () => {
    const itinerary = ultraItinerary(ULTRA_POIS, [], {
      poiAutoSortEnabled: true,
      poiAutoSort: {
        signature: '',
        ranAt: '2026-10-10T00:00:00.000Z',
        summary: { total: 1, byReason: { water: 1, resupply: 0, bakery: 0, meal: 0, night: 0, hotel: 0, gap6h: 0 }, warnings: [], usedPrediction: true },
        picks: [{ id: 1, reason: 'water' }],
      },
    });
    const names = (decode(buildItineraryFitCourse(itinerary, FR)).coursePointMesgs ?? []).map((point) => point.name);
    expect(names).toEqual(['EAU_G10', 'HOT_G11_Hôtel de la Gare']);
    expect(countExportPois(itinerary).roadbook).toBe(2);
  });

  it('sans date de départ, des horaires qui changent selon le jour ne sont pas devinés', () => {
    const itinerary = ultraItinerary(ULTRA_POIS.slice(1, 3), [], { rhythm: { startDate: null, startTime: '06:00' } as unknown as Itinerary['rhythm'] });
    const names = (decode(buildItineraryFitCourse(itinerary, FR)).coursePointMesgs ?? []).map((point) => point.name);
    // « Mo-Su » est le même tous les jours ; « Tu-Su » dépend du jour.
    expect(names).toEqual(['BOU_D03_7-19_La Mie Câline', 'BOU_G06_Chez Paul']);
  });

  it('aller-retour : le côté est celui du passage de la feuille de route', () => {
    // Aller plein nord puis retour plein sud sur la même route.
    const out = routePoints.slice(0, 200);
    const back = out.slice(0, -1).reverse().map((point, i) => ({ ...point, distanceM: out[199]!.distanceM + (i + 1) * STEP_DEG * METERS_PER_DEG_LAT }));
    const points = [...out, ...back];
    const fountainLat = out[50]!.lat;
    const fountainLon = LON0 + 10 / metersPerDegLon;
    const returnKm = (out[199]!.distanceM + (199 - 50) * STEP_DEG * METERS_PER_DEG_LAT) / 1000;
    const itinerary = {
      id: 'ar',
      name: 'Aller-retour',
      discipline: 'road',
      rhythm: { startDate: '2026-10-12', startTime: '06:00' },
      gpxRoute: { name: 'AR', points },
      poiFeatures: [{ id: 9, lat: fountainLat, lon: fountainLon, category: 'fountain', name: null, tags: {} }],
      timeline: [
        { id: 'start', kind: 'start', label: 'Départ', lat: LAT0, lon: LON0, distanceKm: 0 },
        { id: 'poi-9', kind: 'poi', label: 'Fontaine', poiCategory: 'fountains', osmId: 9, lat: fountainLat, lon: fountainLon, distanceKm: returnKm, visible: true },
        { id: 'end', kind: 'end', label: 'Arrivée', lat: LAT0, lon: LON0, distanceKm: points[points.length - 1]!.distanceM / 1000 },
      ],
    } as unknown as Itinerary;
    const [fountain] = decode(buildItineraryFitCourse(itinerary, FR)).coursePointMesgs ?? [];
    // À l'est d'une route parcourue vers le sud : à gauche, au kilomètre du retour.
    expect(fountain?.name).toBe('EAU_G10');
    expect(fountain?.distance as number).toBeCloseTo(returnKm * 1000, -1);
  });
});

describe('export GPX pour Garmin Connect', () => {
  const gpx = buildItineraryGpx(ultraItinerary(ULTRA_POIS, [ZONZA]), FR);

  it('<name> = nom GPS, <cmt> = nom de la feuille de route', () => {
    expect(gpx).toContain('<name>BOU_D03_7-19_La Mie Câline</name>\n  <cmt>La Mie Câline</cmt>');
    expect(gpx).toContain('<name>EAU_G10</name>\n  <cmt>Fontaine</cmt>');
  });

  it('<type> = type de point de parcours Garmin (icône), catégorie RedView en extension', () => {
    // Une catégorie RedView (« fountains ») en <type> devenait un drapeau dans Garmin Connect.
    expect(gpx).toMatch(/<name>EAU_G10<\/name>[\s\S]*?<type>water<\/type>\n {2}<extensions><redview:category>fountain<\/redview:category><\/extensions>/);
    expect(gpx).toMatch(/<name>PHA_D15[^<]*<\/name>[\s\S]*?<type>first_aid<\/type>/);
    expect(gpx).toMatch(/<name>Zonza<\/name>[\s\S]*?<type>checkpoint<\/type>/);
  });

  it('pas de point de départ ni d’arrivée : le compteur a les siens', () => {
    expect(gpx).not.toContain('<type>start</type>');
    expect(gpx).not.toContain('<type>finish</type>');
    // 7 POI de la feuille de route (camping masqué) + Zonza.
    expect(gpx.match(/<wpt /g)).toHaveLength(8);
  });
});
