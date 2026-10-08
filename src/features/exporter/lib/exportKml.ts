import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  buildPoiExportDescription,
  collectExportAnchors,
  escapeXml,
  formatCoordinate,
  formatDecimal,
  getExportRoutePoints,
  KML_NAMESPACE,
  POI_CATEGORY_TO_KML_COLOR,
  type ExportAnchor,
} from './exportHelpers';
import { translateAppText } from '@/shared/i18n/config';

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
  'rv-track': 'ff00aaff', // ligne rouge-orangé vif
  ...Object.fromEntries(
    Object.entries(POI_CATEGORY_TO_KML_COLOR).map(([cat, color]) => [`rv-poi-${cat}`, color]),
  ),
};

/**
 * Génère le fichier KML complet pour un itinéraire avec styles de trace et icônes d'étape.
 */
export function buildItineraryKml(
  itinerary: Itinerary,
  options?: { favoritesOnly?: boolean },
): string {
  const routePoints = getExportRoutePoints(itinerary);
  const anchors = collectExportAnchors(itinerary, routePoints, options);
  const routeName = itinerary.gpxRoute?.name?.trim() || itinerary.name.trim() || translateAppText('Itinéraire');

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
      const description = buildPoiExportDescription(anchor);
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
    `    <description>${escapeXml(translateAppText('Trace et POI favoris exportés depuis RedView.'))}</description>`,
    styleXml,
    '    <Folder>',
    `      <name>${escapeXml(translateAppText('POI favoris'))}</name>`,
    poiPlacemarkXml,
    checkpointPlacemarkXml,
    '    </Folder>',
    '    <Folder>',
    `      <name>${escapeXml(translateAppText('Trace'))}</name>`,
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
