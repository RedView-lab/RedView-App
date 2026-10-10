import { translateAppText } from '@/shared/i18n';
import { ITINERARY_COLORS } from './defaultState';
import type { PoiFeature } from '@/features/poi/types';
import type { Itinerary, ItineraryProject, TimelineItem } from '../../types';
import { formatGpsCoordinateLabel } from '../geocoding/coordinateLabel';
import {
  buildImportedRouteMetrics,
  normalizeImportedRoutePoints,
  projectDistanceAlongRouteM,
  roundDistanceKm,
  routeDistancesM,
} from '../routes';
import { buildPoiRouteSignature } from '../schedule/poiRouteReset';
import { createDocumentId } from './ids';
import { getRoutingInputsSignature } from '../../hooks/useItineraryBrouterRouting/routingInputs';
import {
  interpolateRoutePointAtDistance,
  normalizeRoutePointDistances,
  projectOnRouteRange,
} from '../../hooks/useItineraryBrouterRoutingShared/routeGeometry';

type RoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

export interface SplitItineraryProjectResult {
  project: ItineraryProject;
  createdItineraryId: string;
  createdItineraryName: string;
}

function pickSplitChildColor(project: ItineraryProject, sourceColor: string): string {
  const normalizedSourceColor = sourceColor.trim().toLowerCase();
  const normalizedPalette = ITINERARY_COLORS.map((color) => color.toLowerCase());
  const preferredStartIndex = project.itineraries.length % ITINERARY_COLORS.length;
  const sourcePaletteIndex = normalizedPalette.indexOf(normalizedSourceColor);
  const startIndex = sourcePaletteIndex >= 0 ? sourcePaletteIndex + 1 : preferredStartIndex;

  for (let offset = 0; offset < ITINERARY_COLORS.length; offset += 1) {
    const candidate = ITINERARY_COLORS[(startIndex + offset) % ITINERARY_COLORS.length] ?? sourceColor;
    if (candidate.toLowerCase() !== normalizedSourceColor) return candidate;
  }

  return sourceColor;
}

function buildUniqueSplitName(project: ItineraryProject, sourceName: string): string {
  const baseName = translateAppText('Découpage de {{name}}', { name: sourceName });
  let nextName = baseName;
  let suffix = 2;
  while (project.itineraries.some((itinerary) => itinerary.name === nextName)) {
    nextName = `${baseName} ${suffix}`;
    suffix += 1;
  }
  return nextName;
}

/**
 * Moitié découpée : exactement la portion du tracé d'origine. Aucune édition
 * en attente n'y survit, et un tracé BRouter est estampillé pour ses nouvelles
 * lignes — sans quoi il serait recalculé de bout en bout, autrement.
 */
function stampSplitRoute(itinerary: Itinerary): void {
  delete itinerary.pendingRoutePatch;
  delete itinerary.pendingTraceExtension;
  if (itinerary.gpxRoute?.source === 'brouter') {
    itinerary.gpxRoute = { ...itinerary.gpxRoute, routedInputsKey: getRoutingInputsSignature(itinerary) };
  }
}

/** Position (m) d'une ligne sur le tracé d'origine : son kilométrage, sinon sa projection. */
function rowPositionM(row: TimelineItem, routePoints: RoutePoints, cumulativeM: number[]): number | null {
  if (row.distanceKm != null && Number.isFinite(row.distanceKm)) return row.distanceKm * 1_000;
  if (row.lat == null || row.lon == null) return null;
  return projectDistanceAlongRouteM({ lat: row.lat, lon: row.lon }, routePoints, cumulativeM);
}

/**
 * Feuille de route de chaque moitié : les lignes existantes (étapes nommées,
 * pauses, POI favoris et leurs pauses, noms saisis, lignes masquées) réparties
 * selon leur kilométrage — celles de droite recalées sur son départ —, plus
 * une arrivée (à gauche) et un départ (à droite) posés à la coupe.
 */
function splitTimeline(
  timeline: Itinerary['timeline'],
  routePoints: RoutePoints,
  cumulativeM: number[],
  splitM: number,
  cut: { lat: number; lon: number },
): { left: Itinerary['timeline']; right: Itinerary['timeline'] } {
  const left: Itinerary['timeline'] = [];
  const right: Itinerary['timeline'] = [];
  const shifted = (row: TimelineItem, atM: number): TimelineItem => ({
    ...row,
    distanceKm: row.distanceKm != null ? roundDistanceKm(Math.max(0, atM - splitM)) : null,
  });
  for (const row of timeline) {
    if (row.kind === 'start') {
      left.push({ ...row });
      continue;
    }
    if (row.kind === 'end') {
      right.push(row.distanceKm != null ? shifted(row, row.distanceKm * 1_000) : { ...row });
      continue;
    }
    const atM = rowPositionM(row, routePoints, cumulativeM);
    if (atM == null || atM < splitM) left.push({ ...row });
    else right.push(shifted(row, atM));
  }
  const cutLabel = formatGpsCoordinateLabel(cut.lon, cut.lat);
  const leftEnd: TimelineItem = { id: createDocumentId('end'), kind: 'end', label: cutLabel, distanceKm: roundDistanceKm(splitM), ...cut };
  const rightStart: TimelineItem = { id: createDocumentId('start'), kind: 'start', label: cutLabel, distanceKm: 0, ...cut };
  return { left: [...left, leftEnd], right: [rightStart, ...right] };
}

/** POI de la carte de chaque moitié : ceux de ses lignes, les autres selon leur position. */
function splitPoiFeatures(
  features: PoiFeature[] | undefined,
  timelines: { left: Itinerary['timeline']; right: Itinerary['timeline'] },
  routePoints: RoutePoints,
  cumulativeM: number[],
  splitM: number,
): { left: PoiFeature[]; right: PoiFeature[] } {
  const idsOf = (rows: Itinerary['timeline']) => new Set(rows.map((row) => row.osmId).filter((id) => id != null));
  const leftIds = idsOf(timelines.left);
  const rightIds = idsOf(timelines.right);
  const left: PoiFeature[] = [];
  const right: PoiFeature[] = [];
  for (const feature of features ?? []) {
    if (rightIds.has(feature.id)) right.push(feature);
    else if (leftIds.has(feature.id)) left.push(feature);
    else {
      const atM = projectDistanceAlongRouteM({ lat: feature.lat, lon: feature.lon }, routePoints, cumulativeM);
      (atM != null && atM >= splitM ? right : left).push(feature);
    }
  }
  return { left, right };
}

/**
 * Points d'origine (non simplifiés) d'un GPX importé coupés au même endroit
 * que le tracé : l'export GPX et la prédiction gardent toute la résolution.
 * `null` sans points d'origine distincts du tracé.
 */
function splitOriginalPoints(
  route: NonNullable<Itinerary['gpxRoute']>,
  splitM: number,
  routeTotalM: number,
  cut: { lat: number; lon: number },
): { left: RoutePoints; right: RoutePoints } | null {
  const original = route.originalPoints as RoutePoints | undefined;
  if (!original || original === route.points || original.length < 2) return null;
  const distances = routeDistancesM(original);
  const totalM = distances[distances.length - 1] ?? 0;
  // Même fraction du parcours : retrouve le bon passage d'une boucle.
  const preferM = routeTotalM > 0 ? (splitM / routeTotalM) * totalM : splitM;
  const projection = projectOnRouteRange(cut, original, distances, 0, totalM, preferM);
  if (!projection) return null;
  const cutPoint = interpolateRoutePointAtDistance(original, distances, projection.alongM);
  if (!cutPoint) return null;
  const leftPoints: RoutePoints = [];
  const rightPoints: RoutePoints = [cutPoint];
  for (let index = 0; index < original.length; index += 1) {
    if (distances[index]! < projection.alongM - 1e-6) leftPoints.push({ ...original[index]! });
    else if (distances[index]! > projection.alongM + 1e-6) rightPoints.push({ ...original[index]! });
  }
  leftPoints.push(cutPoint);
  if (leftPoints.length < 2 || rightPoints.length < 2) return null;
  return { left: normalizeRoutePointDistances(leftPoints), right: normalizeRoutePointDistances(rightPoints) };
}

export function splitItineraryProject(
  project: ItineraryProject,
  itineraryId: string,
  splitIndex: number,
): SplitItineraryProjectResult | null {
  const source = project.itineraries.find((itinerary) => itinerary.id === itineraryId);
  const route = source?.gpxRoute;
  if (!source || !route || route.points.length < 4) return null;

  const safeSplitIndex = Math.max(1, Math.min(splitIndex, route.points.length - 2));
  const leftPoints = normalizeImportedRoutePoints(route.points.slice(0, safeSplitIndex + 1));
  const rightPoints = normalizeImportedRoutePoints(route.points.slice(safeSplitIndex));
  if (leftPoints.length < 2 || rightPoints.length < 2) return null;

  const cumulativeM = routeDistancesM(route.points);
  const splitM = cumulativeM[safeSplitIndex] ?? 0;
  const routeTotalM = cumulativeM[cumulativeM.length - 1] ?? 0;
  const cut = { lat: route.points[safeSplitIndex]!.lat, lon: route.points[safeSplitIndex]!.lon };
  const timelines = splitTimeline(source.timeline, route.points, cumulativeM, splitM, cut);
  const features = splitPoiFeatures(source.poiFeatures, timelines, route.points, cumulativeM, splitM);
  const originals = splitOriginalPoints(route, splitM, routeTotalM, cut);

  const createdItineraryId = createDocumentId('it');
  const createdItineraryName = buildUniqueSplitName(project, source.name);
  const nextColor = pickSplitChildColor(project, source.color);
  const nextSource: Itinerary = structuredClone(source);
  nextSource.gpxRoute = {
    ...route,
    points: leftPoints,
    // Tracé complet (export GPX, qualité) : la moitié, pas tout l'ancien tracé.
    originalPoints: originals?.left ?? leftPoints,
  };
  nextSource.timeline = timelines.left;
  nextSource.metrics = buildImportedRouteMetrics(leftPoints);
  nextSource.visible = true;
  nextSource.prediction = null;
  // POI de la portion gardés ; la recherche portait déjà sur elle : pas de nouvelle recherche.
  nextSource.poiFeatures = features.left;
  nextSource.poiRouteSignature = buildPoiRouteSignature(leftPoints);
  delete nextSource.poiAutoSort;
  delete nextSource.routeAudit;

  const createdItinerary: Itinerary = structuredClone(source);
  createdItinerary.id = createdItineraryId;
  createdItinerary.name = createdItineraryName;
  createdItinerary.color = nextColor;
  createdItinerary.visible = true;
  createdItinerary.analysisVisible = true;
  delete createdItinerary.splitRelation;
  createdItinerary.gpxRoute = {
    ...route,
    points: rightPoints,
    originalPoints: originals?.right ?? rightPoints,
  };
  createdItinerary.timeline = timelines.right;
  createdItinerary.metrics = buildImportedRouteMetrics(rightPoints);
  createdItinerary.prediction = null;
  delete createdItinerary.fitUploads;
  delete createdItinerary.pendingFitRecompute;
  createdItinerary.poiFeatures = features.right;
  createdItinerary.poiRouteSignature = buildPoiRouteSignature(rightPoints);
  delete createdItinerary.poiAutoSort;
  delete createdItinerary.routeAudit;
  stampSplitRoute(nextSource);
  stampSplitRoute(createdItinerary);

  const nextItineraries: Itinerary[] = [];
  for (const itinerary of project.itineraries) {
    if (itinerary.id === itineraryId) {
      nextItineraries.push(nextSource);
      nextItineraries.push(createdItinerary);
    } else {
      nextItineraries.push(itinerary);
    }
  }

  return {
    project: {
      ...project,
      itineraries: nextItineraries,
      activeItineraryId: createdItineraryId,
    },
    createdItineraryId,
    createdItineraryName,
  };
}