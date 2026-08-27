import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  collectExportAnchors,
  escapeXml,
  formatCoordinate,
  formatDecimal,
  getExportRoutePoints,
  KML_NAMESPACE,
  POI_CATEGORY_LABEL_FR,
  POI_CATEGORY_TO_KML_COLOR,
  type ExportAnchor,
} from './exportHelpers';

function resolvePoiCategoryLabel(anchor: ExportAnchor): string {
  return anchor.poiCategory ? (POI_CATEGORY_LABEL_FR[anchor.poiCategory] ?? 'POI') : 'POI';
}

function kmlStyleIdForAnchor(anchor: ExportAnchor): string {
  if (anchor.kind === 'start') return 'rv-start';
  if (anchor.kind === 'end') return 'rv-end';
  if (anchor.kind === 'waypoint') return 'rv-waypoint';
  return anchor.poiCategory ? `rv-poi-${anchor.poiCategory}` : 'rv-poi';
}

const KML_STYLE_COLORS: Record<string, string> = {
  'rv-start': 'ff008000', // green
  'rv-end': 'ff0000ff', // red
  'rv-waypoint': 'ffff7800', // orange
  'rv-poi': 'ffffffff',
  'rv-track': 'ff00aaff', // bright orange-red line
  ...Object.fromEntries(
    Object.entries(POI_CATEGORY_TO_KML_COLOR).map(([cat, color]) => [`rv-poi-${cat}`, color]),
  ),
};

/**
 * Génère le fichier KML complet pour un itinéraire avec styles de trace et icônes d'étape.
 */
export function buildItineraryKml(itinerary: Itinerary): string {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints, { favoritesOnly: true });
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || 'Itineraire';

  const styleIds = new Set<string>(['rv-track']);
  for (const anchor of anchors) {
    styleIds.add(kmlStyleIdForAnchor(anchor));
  }
  const styleXml = [...styleIds]
    .map((id) => {
      const color = KML_STYLE_COLORS[id] ?? 'ffffffff';
      const isTrack = id === 'rv-track';
      const geometryStyle = isTrack
        ? [
            '      <LineStyle>',
            `        <color>${color}</color>`,
            '        <width>4</width>',
            '      </LineStyle>',
          ].join('\n')
        : [
            '      <IconStyle>',
            `        <color>${color}</color>`,
            '        <scale>1.0</scale>',
            '      </IconStyle>',
            '      <LabelStyle>',
            '        <scale>0.8</scale>',
            '      </LabelStyle>',
          ].join('\n');
      return [
        `    <Style id="${id}">`,
        geometryStyle,
        '    </Style>',
      ].join('\n');
    })
    .join('\n');

  const poiPlacemarkXml = anchors
    .filter((anchor) => anchor.kind === 'poi')
    .map((anchor) => {
      const distanceKm = (anchor.distanceM / 1000).toFixed(1);
      const description = `${resolvePoiCategoryLabel(anchor)} - km ${distanceKm}${anchor.favorite ? ' (favori)' : ''}`;
      const coord = anchor.elevationM != null
        ? `${formatCoordinate(anchor.lon)},${formatCoordinate(anchor.lat)},${formatDecimal(anchor.elevationM, 1)}`
        : `${formatCoordinate(anchor.lon)},${formatCoordinate(anchor.lat)},0`;
      return [
        '    <Placemark>',
        `      <name>${escapeXml(anchor.name)}</name>`,
        `      <description>${escapeXml(description)}</description>`,
        `      <styleUrl>#${kmlStyleIdForAnchor(anchor)}</styleUrl>`,
        '      <Point>',
        `        <coordinates>${coord}</coordinates>`,
        '      </Point>',
        '    </Placemark>',
      ].join('\n');
    })
    .join('\n');

  const checkpointPlacemarkXml = anchors
    .filter((anchor) => anchor.kind !== 'poi')
    .map((anchor) => {
      const coord = anchor.elevationM != null
        ? `${formatCoordinate(anchor.lon)},${formatCoordinate(anchor.lat)},${formatDecimal(anchor.elevationM, 1)}`
        : `${formatCoordinate(anchor.lon)},${formatCoordinate(anchor.lat)},0`;
      return [
        '    <Placemark>',
        `      <name>${escapeXml(anchor.name)}</name>`,
        `      <styleUrl>#${kmlStyleIdForAnchor(anchor)}</styleUrl>`,
        '      <Point>',
        `        <coordinates>${coord}</coordinates>`,
        '      </Point>',
        '    </Placemark>',
      ].join('\n');
    })
    .join('\n');

  const trackCoords = routePoints
    .map((point) => {
      const ele = point.elevationM != null ? formatDecimal(point.elevationM, 1) : '0';
      return `${formatCoordinate(point.lon)},${formatCoordinate(point.lat)},${ele}`;
    })
    .join(' ');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<kml xmlns="${KML_NAMESPACE}">`,
    '  <Document>',
    `    <name>${escapeXml(routeName)}</name>`,
    `    <description>${escapeXml('Trace et POI favoris exportes depuis RedView.')}</description>`,
    styleXml,
    '    <Folder>',
    `      <name>${escapeXml('POI favoris')}</name>`,
    poiPlacemarkXml,
    checkpointPlacemarkXml,
    '    </Folder>',
    '    <Folder>',
    `      <name>${escapeXml('Trace')}</name>`,
    '      <Placemark>',
    `        <name>${escapeXml(routeName)}</name>`,
    '        <styleUrl>#rv-track</styleUrl>',
    '        <LineString>',
    '          <tessellate>1</tessellate>',
    `          <coordinates>${trackCoords}</coordinates>`,
    '        </LineString>',
      '      </Placemark>',
    '    </Folder>',
    '  </Document>',
    '</kml>',
  ].join('\n');
}
