import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  APP_CREATOR,
  buildBounds,
  collectExportAnchors,
  escapeXml,
  formatCoordinate,
  formatDecimal,
  getExportRoutePoints,
  GPX_NAMESPACE,
  POI_CATEGORY_TO_GPX_SYM,
  type ExportAnchor,
} from './exportHelpers';

export function mapPoiCategoryToGpxSym(anchor: ExportAnchor): string {
  if (anchor.kind === 'start') return 'Flag, Green';
  if (anchor.kind === 'end') return 'Flag, Red';
  if (anchor.kind === 'waypoint') return 'Flag, Blue';
  if (anchor.kind === 'poi' && anchor.poiCategory) {
    return POI_CATEGORY_TO_GPX_SYM[anchor.poiCategory] ?? 'Waypoint';
  }
  return 'Waypoint';
}

export function buildGpxWaypointType(anchor: ExportAnchor): string {
  if (anchor.kind === 'start') return 'start';
  if (anchor.kind === 'end') return 'finish';
  if (anchor.kind === 'waypoint') return 'checkpoint';
  return anchor.poiCategory ?? 'poi';
}

export function buildWaypointDescription(anchor: ExportAnchor): string {
  if (anchor.kind === 'waypoint') return 'Point de passage exporte depuis la feuille de route.';
  if (anchor.kind === 'poi') return 'POI exporte depuis RedView pour navigation sur montre ou compteur.';
  if (anchor.kind === 'start') return 'Depart du parcours.';
  if (anchor.kind === 'end') return 'Arrivee du parcours.';
  return 'Point exporte depuis RedView.';
}

/**
 * Génère le fichier GPX complet pour un itinéraire avec ses points de trace, étapes et POIs favoris.
 */
export function buildItineraryGpx(itinerary: Itinerary, options?: { favoritesOnly?: boolean }): string {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints, { favoritesOnly: options?.favoritesOnly ?? true });
  const bounds = buildBounds(routePoints);
  const exportedAt = new Date().toISOString();
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itineraire';

  const waypointXml = anchors
    .map((anchor) => {
      const lines = [
        `<wpt lat="${formatCoordinate(anchor.lat)}" lon="${formatCoordinate(anchor.lon)}">`,
      ];
      if (anchor.elevationM != null) {
        lines.push(`  <ele>${formatDecimal(anchor.elevationM, 1)}</ele>`);
      }
      lines.push(`  <name>${escapeXml(anchor.name)}</name>`);
      lines.push(`  <sym>${escapeXml(mapPoiCategoryToGpxSym(anchor))}</sym>`);
      lines.push(`  <type>${escapeXml(buildGpxWaypointType(anchor))}</type>`);
      lines.push(`  <desc>${escapeXml(buildWaypointDescription(anchor))}</desc>`);
      lines.push('</wpt>');
      return lines.join('\n');
    })
    .join('\n');

  const routeAnchorXml = anchors
    .map((anchor) => {
      const lines = [
        `    <rtept lat="${formatCoordinate(anchor.lat)}" lon="${formatCoordinate(anchor.lon)}">`,
      ];
      if (anchor.elevationM != null) {
        lines.push(`      <ele>${formatDecimal(anchor.elevationM, 1)}</ele>`);
      }
      lines.push(`      <name>${escapeXml(anchor.name)}</name>`);
      lines.push(`      <type>${escapeXml(buildGpxWaypointType(anchor))}</type>`);
      lines.push('    </rtept>');
      return lines.join('\n');
    })
    .join('\n');

  const trackPointXml = routePoints
    .map((point) => {
      const lines = [
        `      <trkpt lat="${formatCoordinate(point.lat)}" lon="${formatCoordinate(point.lon)}">`,
      ];
      if (point.elevationM != null) {
        lines.push(`        <ele>${formatDecimal(point.elevationM, 1)}</ele>`);
      }
      lines.push('      </trkpt>');
      return lines.join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${APP_CREATOR}" xmlns="${GPX_NAMESPACE}">`,
    '  <metadata>',
    `    <name>${escapeXml(routeName)}</name>`,
    `    <time>${exportedAt}</time>`,
    `    <desc>${escapeXml('Trace exportee depuis RedView sans donnees de vitesse, cadence ou puissance.')}</desc>`,
    `    <bounds minlat="${formatCoordinate(bounds.minLat)}" minlon="${formatCoordinate(bounds.minLon)}" maxlat="${formatCoordinate(bounds.maxLat)}" maxlon="${formatCoordinate(bounds.maxLon)}" />`,
    '  </metadata>',
    waypointXml,
    '  <rte>',
    `    <name>${escapeXml(routeName)}</name>`,
    `    <desc>${escapeXml('Points de guidage et POI exportes pour navigation.')}</desc>`,
    routeAnchorXml,
    '  </rte>',
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
