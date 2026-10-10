import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  APP_CREATOR,
  buildBounds,
  buildPoiExportDescription,
  collectExportAnchors,
  escapeXml,
  formatCoordinate,
  formatDecimal,
  getExportRoutePoints,
  GPX_NAMESPACE,
  POI_CATEGORY_TO_GPX_SYM,
  type ExportAnchor,
  type ExportOptions,
} from './exportHelpers';
import { translateAppText } from '@/shared/i18n/config';
import { gpxCoursePointType } from './coursePointTypes';

/** Espace de noms des extensions RedView d'un point (catégorie exacte, relue à l'import). */
const REDVIEW_GPX_NAMESPACE = 'https://redview.tech/xmlns/gpx/1';

function mapPoiCategoryToGpxSym(anchor: ExportAnchor): string {
  if (anchor.kind === 'waypoint') return 'Flag, Blue';
  if (anchor.kind === 'poi' && anchor.poiCategory) {
    return POI_CATEGORY_TO_GPX_SYM[anchor.poiCategory] ?? 'Waypoint';
  }
  return 'Waypoint';
}

function buildWaypointDescription(anchor: ExportAnchor): string {
  if (anchor.kind === 'waypoint') return translateAppText('Point de passage exporté depuis la feuille de route.');
  if (anchor.kind === 'poi') return buildPoiExportDescription(anchor);
  return translateAppText('Point exporté depuis RedView.');
}

/**
 * Génère le fichier GPX complet pour un itinéraire avec ses points de trace,
 * étapes et POI, pensé pour un import dans Garmin Connect :
 *  - `<name>` d'un POI = convention GPS (`CAT_CDD[_horaires][_nom]`,
 *    gpsNames.ts), ce que le compteur affiche ;
 *  - `<type>` = type de point de parcours Garmin (`water`, `food`,
 *    `checkpoint`…), donc la bonne icône ;
 *  - pas de point de départ / d'arrivée : le compteur a les siens, ils
 *    n'ajoutaient que deux drapeaux à la liste ;
 *  - le nom lisible (`<cmt>`) et la catégorie RedView (extension) sont relus
 *    par l'import RedView.
 */
export function buildItineraryGpx(itinerary: Itinerary, options?: ExportOptions): string {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints, options)
    .filter((anchor) => anchor.kind !== 'start' && anchor.kind !== 'end');
  const bounds = buildBounds(routePoints);
  const exportedAt = new Date().toISOString();
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || translateAppText('Itinéraire');

  const waypointXml = anchors
    .map((anchor) => {
      const lines = [
        `<wpt lat="${formatCoordinate(anchor.lat)}" lon="${formatCoordinate(anchor.lon)}">`,
      ];
      if (anchor.elevationM != null) {
        lines.push(`  <ele>${formatDecimal(anchor.elevationM, 1)}</ele>`);
      }
      // Ordre imposé par le schéma GPX 1.1 : name, cmt, desc, …, sym, type, extensions.
      lines.push(`  <name>${escapeXml(anchor.gpsName)}</name>`);
      if (anchor.gpsName !== anchor.name) {
        lines.push(`  <cmt>${escapeXml(anchor.name)}</cmt>`);
      }
      lines.push(`  <desc>${escapeXml(buildWaypointDescription(anchor))}</desc>`);
      lines.push(`  <sym>${escapeXml(mapPoiCategoryToGpxSym(anchor))}</sym>`);
      lines.push(`  <type>${gpxCoursePointType(anchor)}</type>`);
      const category = anchor.featureCategory ?? anchor.poiCategory;
      if (anchor.kind === 'poi' && category) {
        lines.push(`  <extensions><redview:category>${escapeXml(category)}</redview:category></extensions>`);
      }
      lines.push('</wpt>');
      return lines.join('\n');
    })
    .join('\n');

  const ptCount = routePoints.length;
  const trackPointParts = new Array<string>(ptCount);
  for (let i = 0; i < ptCount; i++) {
    const point = routePoints[i]!;
    trackPointParts[i] = point.elevationM != null
      ? `      <trkpt lat="${formatCoordinate(point.lat)}" lon="${formatCoordinate(point.lon)}">\n        <ele>${formatDecimal(point.elevationM, 1)}</ele>\n      </trkpt>`
      : `      <trkpt lat="${formatCoordinate(point.lat)}" lon="${formatCoordinate(point.lon)}">\n      </trkpt>`;
  }
  const trackPointXml = trackPointParts.join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${APP_CREATOR}" xmlns="${GPX_NAMESPACE}" xmlns:redview="${REDVIEW_GPX_NAMESPACE}">`,
    '  <metadata>',
    `    <name>${escapeXml(routeName)}</name>`,
    `    <desc>${escapeXml(translateAppText('Trace exportée depuis RedView sans données de vitesse, cadence ou puissance.'))}</desc>`,
    `    <time>${exportedAt}</time>`,
    `    <bounds minlat="${formatCoordinate(bounds.minLat)}" minlon="${formatCoordinate(bounds.minLon)}" maxlat="${formatCoordinate(bounds.maxLat)}" maxlon="${formatCoordinate(bounds.maxLon)}" />`,
    '  </metadata>',
    waypointXml,
    '  <trk>',
    `    <name>${escapeXml(routeName)}</name>`,
    '    <trkseg>',
    trackPointXml,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ]
    .filter(Boolean)
    .join('\n');
}
