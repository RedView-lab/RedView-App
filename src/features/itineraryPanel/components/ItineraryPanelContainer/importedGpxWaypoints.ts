import {
  GPX_IMPORT_POI_SOURCE,
  POI_CATEGORIES,
  type GpxRoute,
  type GpxWaypoint,
  type PoiCategory as FeaturePoiCategory,
  type PoiFeature,
} from '@/features/poi/types';
import { FEATURE_TO_PANEL_POI, poiFeaturesToTimelineItems } from '../../lib/schedule/poi-to-timeline';
import {
  cumulativeRouteLengthsM,
  haversineRouteDistanceM,
  projectPointAlongRoute,
  roundDistanceKm,
} from '../../lib/routes';
import { formatGpsCoordinateLabel } from '../../lib/geocoding';
import type { PoiCategory as PanelPoiCategory, TimelineItem } from '../../types';

/**
 * Conversion des <wpt> d'un GPX importé vers le modèle de l'app, en miroir de
 * l'export (`exporter/lib/exportGpx.ts`) :
 *   - <type> = catégorie POI du panneau (fountains, bakeries…) ou catégorie
 *     OSM → `PoiFeature` (+ ligne POI de la feuille de route) ;
 *   - <type> start / finish → ignorés (déjà portés par le tracé) ;
 *   - tout le reste (checkpoint, points nommés d'autres outils) → ligne
 *     « point de passage ».
 */

/** Préfixe d'id des points de passage importés (non renommés par géocodage). */
export const GPX_IMPORT_WAYPOINT_ID_PREFIX = 'gpx-wpt-';

/** Rayon maximal du corridor POI côté serveur : au-delà, le POI n'est pas « sur » ce tracé. */
const MAX_POI_OFFSET_M = 10_000;
/** Un point de passage plus loin que ça du tracé appartient à un autre parcours. */
const MAX_WAYPOINT_OFFSET_M = 2_000;
/** En dessous, le point est posé sur la trace (pas un via de routage). */
const ON_ROUTE_TOLERANCE_M = 25;

const REDVIEW_CREATOR = 'RedView';
/**
 * Suffixe que l'export RedView ajoute à la <desc> des POI favoris, dans la
 * langue de l'exportateur : un fichier exporté en anglais perdait ses favoris.
 */
const REDVIEW_FAVORITE_SUFFIXES = ['(favori)', '(favorite)'];

const ENDPOINT_TYPES = new Set(['start', 'finish', 'end']);
const ENDPOINT_SYMS = new Set(['flag, green', 'flag, red']);

const FEATURE_CATEGORY_SET = new Set<string>(POI_CATEGORIES);

/** Catégorie OSM représentative de chaque ligne du panneau (première de la table). */
const PANEL_TO_DEFAULT_FEATURE = new Map<string, FeaturePoiCategory>();
for (const [feature, panel] of Object.entries(FEATURE_TO_PANEL_POI)) {
  if (panel && !PANEL_TO_DEFAULT_FEATURE.has(panel.toLowerCase())) {
    PANEL_TO_DEFAULT_FEATURE.set(panel.toLowerCase(), feature as FeaturePoiCategory);
  }
}

/**
 * Symboles Garmin usuels (dont ceux émis par l'export RedView) → ligne du
 * panneau. Des `Map` : une clé lue dans un fichier (`constructor`,
 * `__proto__`) ne doit jamais tomber sur une propriété d'objet.
 */
const GPX_SYM_TO_PANEL = new Map<string, PanelPoiCategory>(Object.entries({
  'drinking water': 'fountains',
  'water source': 'fountains',
  cemetery: 'cemeteries',
  restroom: 'toilets',
  store: 'supermarkets',
  'shopping center': 'supermarkets',
  'convenience store': 'supermarkets',
  'gas station': 'gasStations',
  restaurant: 'restaurants',
  'fast food': 'fastFood',
  bar: 'bars',
  'bike trail': 'bikeShops',
  lodging: 'hotels',
  campground: 'hotels',
  summit: 'passes',
  'first aid': 'health',
  'medical facility': 'health',
  'ground transportation': 'transport',
} satisfies Record<string, PanelPoiCategory>));

/**
 * Types de points de parcours Garmin (`<type>` des exports RedView et Garmin
 * Connect) → ligne du panneau. `checkpoint`, `generic`… restent des points de
 * passage.
 */
const GARMIN_COURSE_TYPE_TO_PANEL = new Map<string, PanelPoiCategory>(Object.entries({
  water: 'fountains',
  food: 'restaurants',
  store: 'supermarkets',
  toilet: 'toilets',
  shower: 'toilets',
  shelter: 'hotels',
  campsite: 'hotels',
  first_aid: 'health',
  summit: 'passes',
  overlook: 'passes',
  rest_area: 'passes',
  transport: 'transport',
} satisfies Record<string, PanelPoiCategory>));

function resolveFeatureCategory(waypoint: GpxWaypoint): FeaturePoiCategory | null {
  // Export RedView : la catégorie exacte, en extension.
  const exact = waypoint.redviewCategory?.trim();
  if (exact && FEATURE_CATEGORY_SET.has(exact)) return exact as FeaturePoiCategory;
  const exactPanel = exact ? PANEL_TO_DEFAULT_FEATURE.get(exact.toLowerCase()) : undefined;
  if (exactPanel) return exactPanel;
  const type = waypoint.type?.trim();
  if (type) {
    if (FEATURE_CATEGORY_SET.has(type)) return type as FeaturePoiCategory;
    const fromPanel = PANEL_TO_DEFAULT_FEATURE.get(type.toLowerCase());
    if (fromPanel) return fromPanel;
    const garminPanel = GARMIN_COURSE_TYPE_TO_PANEL.get(type.toLowerCase());
    if (garminPanel) return PANEL_TO_DEFAULT_FEATURE.get(garminPanel.toLowerCase()) ?? null;
  }
  const sym = waypoint.sym?.trim().toLowerCase();
  const panelFromSym = sym ? GPX_SYM_TO_PANEL.get(sym) : undefined;
  return panelFromSym ? PANEL_TO_DEFAULT_FEATURE.get(panelFromSym.toLowerCase()) ?? null : null;
}

/**
 * Nom lisible d'un point : dans un export RedView, le `<name>` d'un POI est
 * son nom GPS (`BOU_D03_7-19_La Mie Câline`) et le nom de la feuille de route
 * est dans `<cmt>`.
 */
function resolveWaypointName(waypoint: GpxWaypoint, isRedViewExport: boolean): string | null {
  const comment = waypoint.cmt?.trim();
  return isRedViewExport && comment ? comment : waypoint.name;
}

function isEndpointWaypoint(waypoint: GpxWaypoint): boolean {
  const type = waypoint.type?.trim().toLowerCase();
  if (type && ENDPOINT_TYPES.has(type)) return true;
  const sym = waypoint.sym?.trim().toLowerCase();
  return Boolean(sym && ENDPOINT_SYMS.has(sym));
}

export interface ImportedGpxWaypoints {
  poiFeatures: PoiFeature[];
  /** Lignes POI de la feuille de route, triées par distance. */
  poiRows: TimelineItem[];
  /** Points de passage intermédiaires, triés par distance. */
  waypointRows: TimelineItem[];
}

/**
 * @param idSeed graine des ids négatifs des POI importés (unicité entre imports).
 */
export function buildImportedGpxWaypoints(
  route: Pick<GpxRoute, 'creator' | 'waypoints'>,
  routePoints: Array<{ lat: number; lon: number }>,
  idSeed: number = Date.now(),
): ImportedGpxWaypoints {
  const waypoints = route.waypoints ?? [];
  if (waypoints.length === 0 || routePoints.length < 2) {
    return { poiFeatures: [], poiRows: [], waypointRows: [] };
  }

  const isRedViewExport = route.creator?.trim() === REDVIEW_CREATOR;
  const cumulativeLengths = cumulativeRouteLengthsM(routePoints);
  const poiFeatures: PoiFeature[] = [];
  const waypointRows: TimelineItem[] = [];
  const idBase = Math.floor(Math.abs(idSeed)) * 1000;

  const seen = new Set<string>();

  waypoints.forEach((waypoint, index) => {
    if (isEndpointWaypoint(waypoint)) return;
    // Boucles : certains outils répètent le point de départ en fin de liste.
    const dedupeKey = `${waypoint.lat.toFixed(6)}|${waypoint.lon.toFixed(6)}|${waypoint.name ?? ''}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const projected = projectPointAlongRoute(waypoint, routePoints, cumulativeLengths);
    if (!projected) return;
    const name = resolveWaypointName(waypoint, isRedViewExport);
    const offsetM = haversineRouteDistanceM(waypoint, projected);
    const category = resolveFeatureCategory(waypoint);

    if (category) {
      if (offsetM > MAX_POI_OFFSET_M) return;
      // Un export RedView marque ses favoris ; ailleurs, un POI placé à la main
      // dans le fichier est un choix explicite : on le garde en favori pour
      // qu'une recherche POI ultérieure ne l'efface pas.
      const favorite = isRedViewExport
        ? REDVIEW_FAVORITE_SUFFIXES.some((suffix) => waypoint.desc?.trim().endsWith(suffix) === true)
        : true;
      const tags: Record<string, string> = { source: GPX_IMPORT_POI_SOURCE };
      if (waypoint.elevationM != null) tags.ele = String(waypoint.elevationM);
      poiFeatures.push({
        id: -(idBase + index),
        lat: waypoint.lat,
        lon: waypoint.lon,
        category,
        name,
        tags,
        favorite,
        ...(favorite ? { favoriteSource: 'manual' as const } : {}),
      });
      return;
    }

    if (offsetM > MAX_WAYPOINT_OFFSET_M) return;
    waypointRows.push({
      id: `${GPX_IMPORT_WAYPOINT_ID_PREFIX}${index}`,
      kind: 'waypoint',
      label: name ?? formatGpsCoordinateLabel(waypoint.lon, waypoint.lat),
      distanceKm: roundDistanceKm(projected.distanceM),
      lat: waypoint.lat,
      lon: waypoint.lon,
      ...(offsetM <= ON_ROUTE_TOLERANCE_M ? { onRoute: true } : {}),
      visible: true,
    });
  });

  waypointRows.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

  return {
    poiFeatures,
    poiRows: poiFeaturesToTimelineItems(poiFeatures, routePoints),
    waypointRows,
  };
}
