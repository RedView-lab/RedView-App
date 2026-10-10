import type { PredictionResult } from '@/features/fitPredictor';
import { haversineRouteDistanceM, projectPointAlongRoute } from '@/features/itineraryPanel/lib/routes';
import { FEATURE_TO_PANEL_POI, getPoiAutoSortPicks, keepsTimelineItemWithPoiAutoSort } from '@/features/itineraryPanel/lib/schedule';
import { buildRoutePassageClock, type RoutePassageClock } from '@/features/itineraryPanel/lib/schedule/passageClock';
import type { Itinerary, TimelineItem } from '@/features/itineraryPanel/types';
import { openingIntervalsOnDate, type OpeningInterval } from '@/features/poi/lib/autoSort/openingHours';
import { projectOntoSegmentLocal } from '@/features/poi/lib/refinePoiProjection';
import { POI_LABELS, type PoiCategory as FeaturePoiCategory, type PoiFeature } from '@/features/poi/types';
import { readDocumentAppLocale, translateAppText } from '@/shared/i18n/config';
import { slugFileName } from '@/shared/lib/fileName';
import { buildGpsPoiName, type GpsNameLocale, type RouteSide } from './gpsNames';

export interface ExportAnchor {
  id: string;
  /** Nom lisible (celui de la feuille de route) : KML, commentaire GPX. */
  name: string;
  /**
   * Nom affiché par le GPS : convention `CAT_CDD[_horaires][_nom]` pour un
   * POI (gpsNames.ts), le nom tel quel pour une étape.
   */
  gpsName: string;
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
  kind: TimelineItem['kind'];
  poiCategory?: TimelineItem['poiCategory'];
  /** Catégorie OSM fine (fontaine, boulangerie, camping…), quand le POI est connu. */
  featureCategory?: FeaturePoiCategory;
  favorite?: boolean;
}

export interface ExportRoutePoint {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
}

/**
 * POI exportés avec la trace :
 *  - `roadbook` : ceux de la feuille de route (filtre du tri auto compris),
 *    sans les lignes masquées (œil) ;
 *  - `favorites` : les favoris (étoile), sans les lignes masquées ;
 *  - `all` : tous les POI chargés le long du tracé ;
 *  - `none` : aucun (étapes seulement).
 */
export type ExportPoiScope = 'roadbook' | 'favorites' | 'all' | 'none';

export interface ExportOptions {
  pois?: ExportPoiScope;
  /** Prédiction de l'itinéraire (heures de passage) ; défaut : celle enregistrée sur l'itinéraire. */
  prediction?: PredictionResult | null;
  /** Langue des codes de catégorie et du côté (G/D ou L/R) ; défaut : celle de l'app. */
  locale?: GpsNameLocale;
  /** Instant de l'export (départ supposé quand le Rythme n'a pas de date). */
  now?: Date;
}

export const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
export const KML_NAMESPACE = 'http://www.opengis.net/kml/2.2';
export const APP_CREATOR = 'RedView';
export const FIT_PRODUCT_ID = 1;

export const POI_CATEGORY_TO_GPX_SYM: Record<string, string> = {
  fountains: 'Drinking Water',
  toilets: 'Restroom',
  supermarkets: 'Store',
  gasStations: 'Gas Station',
  bakeries: 'Restaurant',
  fastFood: 'Restaurant',
  cafes: 'Restaurant',
  bars: 'Bar',
  restaurants: 'Restaurant',
  bikeShops: 'Bike Trail',
  hotels: 'Lodging',
  refuges: 'Lodging',
  passes: 'Summit',
  health: 'First Aid',
  transport: 'Ground Transportation',
};

export const POI_CATEGORY_TO_KML_COLOR: Record<string, string> = {
  fountains: 'ff0047e1',
  toilets: 'ff852c31',
  supermarkets: 'ff00b1f1',
  gasStations: 'ff0035ca',
  bakeries: 'ff0069ff',
  fastFood: 'ff0069ff',
  cafes: 'ff5721ff',
  bars: 'ff3600c7',
  restaurants: 'ff36088b',
  bikeShops: 'ff8e7563',
  hotels: 'ff368200',
  refuges: 'ff00cf7d',
  passes: 'ff8e7563',
  health: 'ff0000d6',
  transport: 'ff646464',
};

/** Libellés source (FR) ; traduits dans la langue de l'utilisateur au moment de l'export (`resolvePoiCategoryExportLabel`). */
const POI_CATEGORY_LABEL_FR: Record<string, string> = {
  fountains: "Point d'eau",
  toilets: 'Toilettes',
  supermarkets: 'Supermarché',
  gasStations: 'Station-service',
  bakeries: 'Boulangerie',
  fastFood: 'Restauration rapide',
  cafes: 'Café',
  bars: 'Bar',
  restaurants: 'Restaurant',
  bikeShops: 'Magasin de vélo',
  hotels: 'Hôtel',
  refuges: 'Refuge / gîte',
  passes: 'Col',
  health: 'Santé',
  transport: 'Transport',
};

/** Libellé de catégorie écrit dans les fichiers exportés, dans la langue de l'utilisateur. */
function resolvePoiCategoryExportLabel(poiCategory: string | undefined): string {
  const label = poiCategory ? POI_CATEGORY_LABEL_FR[poiCategory] : undefined;
  return label ? translateAppText(label) : 'POI';
}

/** Description « <catégorie> - km 12.3 » (+ marque de favori) d'un POI exporté. */
export function buildPoiExportDescription(anchor: ExportAnchor): string {
  const vars = {
    category: resolvePoiCategoryExportLabel(anchor.poiCategory),
    km: (anchor.distanceM / 1000).toFixed(1),
  };
  return anchor.favorite
    ? translateAppText('{{category}} - km {{km}} (favori)', vars)
    : translateAppText('{{category}} - km {{km}}', vars);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function buildExportFileName(itinerary: Itinerary, format: string): string {
  const baseName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'itinerary';
  return `${slugFileName(baseName, 'itinerary')}.${format}`;
}

export function getExportRoutePoints(itinerary: Itinerary): ExportRoutePoint[] {
  const points = itinerary.gpxRoute?.originalPoints ?? itinerary.gpxRoute?.points;
  if (!points || points.length < 2) {
    throw new Error(translateAppText("L'itinéraire actif n'a pas de trace exportable."));
  }

  // Distances cumulées croissantes : la recherche du passage d'un POI les
  // parcourt par dichotomie.
  const out = new Array<ExportRoutePoint>(points.length);
  let travelled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (index > 0) {
      const previous = points[index - 1]!;
      travelled += haversineRouteDistanceM(previous, point);
    }
    const stored = Number.isFinite(point.distanceM) ? Math.max(0, point.distanceM as number) : travelled;
    out[index] = {
      lat: point.lat,
      lon: point.lon,
      distanceM: index > 0 ? Math.max(stored, out[index - 1]!.distanceM) : stored,
      elevationM: Number.isFinite(point.elevationM) ? (point.elevationM as number) : null,
    };
  }
  return out;
}

function isPoiKind(kind: TimelineItem['kind']): boolean {
  return kind === 'poi' || kind === 'water' || kind === 'supermarket';
}

function shouldExportTimelineItem(item: TimelineItem): boolean {
  return item.kind === 'start'
    || item.kind === 'end'
    || item.kind === 'waypoint'
    || isPoiKind(item.kind);
}

function defaultAnchorName(item: TimelineItem): string {
  switch (item.kind) {
    case 'start':
      return translateAppText('Départ');
    case 'end':
      return translateAppText('Arrivée');
    case 'waypoint':
      return translateAppText('Waypoint');
    case 'poi':
    case 'water':
    case 'supermarket':
      return 'POI';
    default:
      return translateAppText('Point');
  }
}

// ── POI retenus ──────────────────────────────────────────────────────────

interface SelectedPois {
  rows: TimelineItem[];
  /** POI chargés sans ligne dans la feuille de route. */
  features: PoiFeature[];
}

/**
 * POI d'un périmètre d'export, avant toute géométrie (comptés par le
 * panneau Exporter pour chaque choix).
 */
function selectExportPois(itinerary: Itinerary, scope: ExportPoiScope): SelectedPois {
  if (scope === 'none') return { rows: [], features: [] };
  const picks = getPoiAutoSortPicks(itinerary);
  const rows: TimelineItem[] = [];
  const rowOsmIds = new Set<number>();
  for (const item of itinerary.timeline ?? []) {
    if (!isPoiKind(item.kind)) continue;
    if (item.osmId != null) rowOsmIds.add(Number(item.osmId));
    if (scope !== 'all' && item.visible === false) continue;
    if (scope === 'favorites' && !item.favorite) continue;
    if (scope === 'roadbook' && picks && !keepsTimelineItemWithPoiAutoSort(item, picks)) continue;
    rows.push(item);
  }
  // Un favori sans ligne (anciens projets) part avec les favoris et la feuille
  // de route ; « tous » prend chaque POI chargé.
  const features = (itinerary.poiFeatures ?? []).filter((feature) =>
    !rowOsmIds.has(Number(feature.id)) && (scope === 'all' || Boolean(feature.favorite)));
  return { rows, features };
}

/** Nombre de POI exportés pour chaque périmètre (sans doublon de position / nom). */
export function countExportPois(itinerary: Itinerary): Record<Exclude<ExportPoiScope, 'none'>, number> {
  const count = (scope: ExportPoiScope) => {
    const { rows, features } = selectExportPois(itinerary, scope);
    const keys = new Set<string>();
    for (const row of rows) {
      if (Number.isFinite(row.lat) && Number.isFinite(row.lon)) keys.add(row.osmId != null ? `#${row.osmId}` : `${row.lat}|${row.lon}|${row.label}`);
    }
    for (const feature of features) keys.add(`#${feature.id}`);
    return keys.size;
  };
  return { roadbook: count('roadbook'), favorites: count('favorites'), all: count('all') };
}

// ── Passage d'un point sur la trace exportée ────────────────────────────

/** Fenêtre de recherche autour du kilomètre de la feuille de route (la trace exportée peut être l'originale, plus longue). */
const PASSAGE_WINDOW_MIN_M = 3_000;
const PASSAGE_WINDOW_RATIO = 0.03;
/** Écart toléré pour garder le passage de la feuille de route plutôt que le plus proche. */
const PASSAGE_LATERAL_TOLERANCE_M = 30;

interface RoutePassage {
  distanceM: number;
  lateralM: number;
  side: RouteSide | null;
}

/** Premier indice dont la distance cumulée atteint `distanceM`. */
function lowerBoundIndex(routePoints: ExportRoutePoint[], distanceM: number): number {
  let lo = 0;
  let hi = routePoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (routePoints[mid]!.distanceM < distanceM) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Segment le plus proche du point entre deux distances cumulées. */
function scanPassage(
  routePoints: ExportRoutePoint[],
  point: { lat: number; lon: number },
  fromM: number,
  toM: number,
): RoutePassage | null {
  const first = Math.max(0, lowerBoundIndex(routePoints, fromM) - 1);
  const last = Math.min(routePoints.length - 1, lowerBoundIndex(routePoints, toM) + 1);
  let best: { distanceM: number; lateralM: number; cross: number } | null = null;
  for (let index = first; index < last; index += 1) {
    const a = routePoints[index]!;
    const b = routePoints[index + 1]!;
    const segment = projectOntoSegmentLocal(a, b, point.lat, point.lon);
    if (best && segment.distanceM >= best.lateralM) continue;
    best = {
      distanceM: a.distanceM + segment.t * (b.distanceM - a.distanceM),
      lateralM: segment.distanceM,
      cross: segment.cross,
    };
  }
  if (!best) return null;
  // x = est, y = nord : produit vectoriel > 0 ⇒ à gauche du sens de marche.
  const side: RouteSide | null = best.cross > 0 ? 'left' : best.cross < 0 ? 'right' : null;
  return { distanceM: best.distanceM, lateralM: best.lateralM, side };
}

/**
 * Passage de la trace exportée près d'un point. Le plus proche, sauf quand la
 * feuille de route le place ailleurs (`hintM`) et qu'un passage à peine plus
 * loin y existe : sur un aller-retour, le côté est celui de ce passage-là.
 */
function locatePassage(
  routePoints: ExportRoutePoint[],
  projectionPoints: Array<{ lat: number; lon: number }>,
  cumulativeM: number[],
  point: { lat: number; lon: number },
  hintM: number | null,
): RoutePassage | null {
  const nearest = projectPointAlongRoute(point, projectionPoints, cumulativeM);
  const global = nearest ? scanPassage(routePoints, point, nearest.distanceM - 200, nearest.distanceM + 200) : null;
  if (hintM == null || !Number.isFinite(hintM)) return global;
  const window = Math.max(PASSAGE_WINDOW_MIN_M, hintM * PASSAGE_WINDOW_RATIO);
  if (global && Math.abs(global.distanceM - hintM) <= window) return global;
  const hinted = scanPassage(routePoints, point, hintM - window, hintM + window);
  if (!global) return hinted;
  if (hinted && hinted.lateralM <= global.lateralM + PASSAGE_LATERAL_TOLERANCE_M) return hinted;
  return global;
}

function elevationAtDistance(routePoints: ExportRoutePoint[], distanceM: number): number | null {
  const index = lowerBoundIndex(routePoints, distanceM);
  const after = routePoints[Math.min(index, routePoints.length - 1)]!;
  const before = routePoints[Math.max(0, index - 1)]!;
  const nearest = Math.abs(before.distanceM - distanceM) <= Math.abs(after.distanceM - distanceM) ? before : after;
  return nearest.elevationM ?? before.elevationM ?? after.elevationM ?? null;
}

// ── Noms ─────────────────────────────────────────────────────────────────

let defaultPoiLabels: Set<string> | null = null;

/** Libellé générique d'une ligne de POI sans nom (« Fontaine », « Point d'eau potable », « POI »…), dans les deux langues. */
function isDefaultPoiLabel(label: string): boolean {
  if (!defaultPoiLabels) {
    const sources = [...Object.values(POI_LABELS), ...Object.values(POI_CATEGORY_LABEL_FR), 'POI'];
    defaultPoiLabels = new Set(
      sources.flatMap((text) => [text, translateAppText(text, undefined, 'fr'), translateAppText(text, undefined, 'en')])
        .map((text) => text.trim().toLowerCase()),
    );
  }
  return defaultPoiLabels.has(label.trim().toLowerCase());
}

/** Nom propre d'un POI : le libellé s'il n'est pas générique, sinon le nom OSM, sinon la marque. */
function resolvePlaceName(label: string | null | undefined, feature: PoiFeature | undefined): string | null {
  const candidates = [label, feature?.name, feature?.tags?.brand];
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text && !isDefaultPoiLabel(text)) return text;
  }
  return null;
}

interface PoiNamingContext {
  clock: RoutePassageClock;
  totalM: number;
  locale: GpsNameLocale;
}

function buildPoiGpsName(
  naming: PoiNamingContext,
  passage: RoutePassage,
  poi: {
    feature: PoiFeature | undefined;
    panelCategory: TimelineItem['poiCategory'];
    label: string | null;
    labelEdited: boolean;
  },
): string {
  const openingHours = poi.feature?.tags?.opening_hours;
  let openingIntervals: OpeningInterval[] | null = null;
  if (openingHours) {
    const seconds = naming.clock.scheduledSecondsAt(passage.distanceM, naming.totalM);
    const arrival = new Date(naming.clock.start.getTime() + seconds * 1000);
    openingIntervals = openingIntervalsOnDate(openingHours, arrival, naming.clock.hasRealDate);
  }
  return buildGpsPoiName({
    featureCategory: poi.feature?.category,
    panelCategory: poi.panelCategory,
    lateralM: passage.lateralM,
    side: passage.side,
    openingIntervals,
    placeName: resolvePlaceName(poi.labelEdited ? null : poi.label, poi.feature),
    editedName: poi.labelEdited ? poi.label : null,
  }, naming.locale);
}

// ── Ancres ───────────────────────────────────────────────────────────────

/**
 * Étapes et POI exportés avec la trace, triés par distance : position,
 * kilomètre sur la trace exportée, altitude, nom lisible et nom GPS.
 */
export function collectExportAnchors(
  itinerary: Itinerary,
  routePoints: ExportRoutePoint[],
  options?: ExportOptions,
): ExportAnchor[] {
  const scope = options?.pois ?? 'roadbook';
  const selected = selectExportPois(itinerary, scope);
  const selectedRows = new Set(selected.rows);
  const featuresById = new Map<number, PoiFeature>();
  for (const feature of itinerary.poiFeatures ?? []) featuresById.set(Number(feature.id), feature);

  const projectionPoints = routePoints.map((point) => ({ lat: point.lat, lon: point.lon }));
  const cumulativeM = routePoints.map((point) => point.distanceM);
  const totalDistanceM = routePoints[routePoints.length - 1]?.distanceM ?? 0;
  const naming: PoiNamingContext = {
    clock: buildRoutePassageClock(itinerary, options?.prediction ?? itinerary.prediction, options?.now),
    totalM: totalDistanceM,
    locale: options?.locale ?? readDocumentAppLocale(),
  };

  const anchors: ExportAnchor[] = [];
  const seen = new Set<string>();
  const seenOsmIds = new Set<number>();

  for (const item of itinerary.timeline ?? []) {
    if (!shouldExportTimelineItem(item)) continue;
    const isPoi = isPoiKind(item.kind);
    if (isPoi && !selectedRows.has(item)) continue;
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const lat = item.lat as number;
    const lon = item.lon as number;

    const dedupeKey = `${isPoi ? 'poi' : item.kind}|${lat.toFixed(5)}|${lon.toFixed(5)}|${item.label.trim()}`;
    if (seen.has(dedupeKey)) continue;
    if (isPoi && item.osmId != null && seenOsmIds.has(Number(item.osmId))) continue;

    const hintM = Number.isFinite(item.distanceKm) ? Math.max(0, (item.distanceKm as number) * 1000) : null;
    let passage: RoutePassage | null;
    if (item.kind === 'start') passage = { distanceM: 0, lateralM: 0, side: null };
    else if (item.kind === 'end') passage = { distanceM: totalDistanceM, lateralM: 0, side: null };
    else passage = locatePassage(routePoints, projectionPoints, cumulativeM, { lat, lon }, hintM);
    if (!passage) continue;
    seen.add(dedupeKey);
    if (isPoi && item.osmId != null) seenOsmIds.add(Number(item.osmId));

    const distanceM = Math.max(0, Math.min(totalDistanceM, passage.distanceM));
    const name = item.label.trim() || defaultAnchorName(item);
    const feature = item.osmId != null ? featuresById.get(Number(item.osmId)) : undefined;
    const panelCategory = item.poiCategory ?? (
      feature ? FEATURE_TO_PANEL_POI[feature.category]
        : item.kind === 'water' ? 'fountains' : item.kind === 'supermarket' ? 'supermarkets' : undefined
    );

    anchors.push({
      id: item.id,
      name,
      gpsName: isPoi
        ? buildPoiGpsName(naming, passage, { feature, panelCategory, label: item.label, labelEdited: item.labelEdited === true })
        : name,
      lat,
      lon,
      distanceM,
      elevationM: elevationAtDistance(routePoints, distanceM),
      kind: isPoi ? 'poi' : item.kind,
      poiCategory: panelCategory,
      featureCategory: feature?.category,
      favorite: isPoi ? Boolean(item.favorite) : undefined,
    });
  }

  for (const feature of selected.features) {
    if (!Number.isFinite(feature.lat) || !Number.isFinite(feature.lon)) continue;
    if (seenOsmIds.has(Number(feature.id))) continue;
    const label = feature.name?.trim() || (POI_LABELS[feature.category] ? translateAppText(POI_LABELS[feature.category]) : 'POI');
    const dedupeKey = `poi|${feature.lat.toFixed(5)}|${feature.lon.toFixed(5)}|${(feature.name ?? '').trim()}`;
    if (seen.has(dedupeKey)) continue;

    const passage = locatePassage(routePoints, projectionPoints, cumulativeM, feature, null);
    if (!passage) continue;
    seen.add(dedupeKey);
    seenOsmIds.add(Number(feature.id));

    const distanceM = Math.max(0, Math.min(totalDistanceM, passage.distanceM));
    const panelCategory = FEATURE_TO_PANEL_POI[feature.category];
    const elevation = feature.tags?.ele != null ? parseFloat(feature.tags.ele) : Number.NaN;
    anchors.push({
      id: `poi-${feature.id}`,
      name: label,
      gpsName: buildPoiGpsName(naming, passage, { feature, panelCategory, label: feature.name, labelEdited: false }),
      lat: feature.lat,
      lon: feature.lon,
      distanceM,
      elevationM: Number.isFinite(elevation) ? elevation : elevationAtDistance(routePoints, distanceM),
      kind: 'poi',
      poiCategory: panelCategory,
      featureCategory: feature.category,
      favorite: Boolean(feature.favorite),
    });
  }

  anchors.sort((left, right) => left.distanceM - right.distanceM);
  return anchors;
}

/**
 * Nom GPS de chaque ligne de POI de la feuille de route (id de ligne → nom),
 * tel que l'export l'écrira : colonne « Nom GPS » de la feuille de route.
 */
export function buildRoadbookGpsNames(itinerary: Itinerary, options?: ExportOptions): Map<string, string> {
  const names = new Map<string, string>();
  const routePoints = itinerary.gpxRoute?.originalPoints ?? itinerary.gpxRoute?.points;
  if (!routePoints || routePoints.length < 2) return names;
  for (const anchor of collectExportAnchors(itinerary, getExportRoutePoints(itinerary), { ...options, pois: 'all' })) {
    if (anchor.kind === 'poi') names.set(anchor.id, anchor.gpsName);
  }
  return names;
}

export function buildBounds(routePoints: ExportRoutePoint[]) {
  let minLat = routePoints[0]!.lat;
  let maxLat = routePoints[0]!.lat;
  let minLon = routePoints[0]!.lon;
  let maxLon = routePoints[0]!.lon;

  for (let index = 1; index < routePoints.length; index += 1) {
    const point = routePoints[index]!;
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }

  return { minLat, maxLat, minLon, maxLon };
}

export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

export function formatDecimal(value: number, digits: number): string {
  return roundTo(value, digits).toFixed(digits);
}

export function escapeXml(value: string): string {
  return value
    // XML 1.0 interdit les caractères de contrôle C0 (hors tab, LF, CR) et
    // U+FFFE / U+FFFF, même échappés.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
