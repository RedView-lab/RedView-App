// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { parseGpxFile } from '@/features/poi/lib/gpx-loader';
import { GPX_PARSE_ERROR_MESSAGES, GpxParseError, parseGpxText } from '@/features/poi/lib/gpx-parse';

import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
  simplifyPointsByQuality,
} from '../../lib/routes';
import { cleanAndInterpolateElevations } from '../../lib/route-metrics';
import { buildImportedGpxWaypoints } from './importedGpxWaypoints';
import { describeGpxImportError, GpxFileTooLargeError } from './useItineraryGpxImport';

/**
 * Étapes locales de l'import GPX (useItineraryGpxImport), sans le réseau
 * (altimétrie IGN, liaison des discontinuités, revêtements) : un fichier
 * limite accepté ne doit produire ni NaN ni Infinity dans l'itinéraire.
 */
function importLocally(text: string) {
  const route = parseGpxText(text);
  const storedPoints = normalizeImportedRoutePoints(cleanAndInterpolateElevations(route.points), { includeGradient: false });
  const simplifiedPoints = normalizeImportedRoutePoints(simplifyPointsByQuality(storedPoints, 'default'));
  const waypoints = buildImportedGpxWaypoints(route, simplifiedPoints, 1);
  return {
    storedPoints,
    simplifiedPoints,
    metrics: buildImportedRouteMetrics(storedPoints),
    timeline: createImportedTimeline(storedPoints, waypoints.waypointRows),
    waypoints,
  };
}

function nonFiniteNumbers(value: unknown): string[] {
  const found: string[] = [];
  JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) found.push(`${key}=${v}`);
    return v;
  });
  return found;
}

const wrap = (body: string) => `<?xml version="1.0"?><gpx version="1.1" creator="test">${body}</gpx>`;

describe('import GPX — fichiers limites acceptés', () => {
  const cases: Record<string, string> = {
    'deux points sans altitude': wrap('<trk><trkseg><trkpt lat="44" lon="6"/><trkpt lat="44.001" lon="6"/></trkseg></trk>'),
    'altitude sur un seul point': wrap('<trk><trkseg><trkpt lat="44" lon="6"><ele>500</ele></trkpt><trkpt lat="44.01" lon="6"/><trkpt lat="44.02" lon="6"/></trkseg></trk>'),
    'points en double': wrap('<trk><trkseg><trkpt lat="44" lon="6"><ele>500</ele></trkpt><trkpt lat="44" lon="6"><ele>500</ele></trkpt><trkpt lat="44.01" lon="6"><ele>600</ele></trkpt></trkseg></trk>'),
    'route <rte> seule': wrap('<rte><rtept lat="44" lon="6"/><rtept lat="44.5" lon="6.5"/></rte>'),
    'segments vides et séparés': wrap('<trk><trkseg/><trkseg><trkpt lat="44" lon="6"/><trkpt lat="44.01" lon="6"/></trkseg><trkseg><trkpt lat="44.2" lon="6"/><trkpt lat="44.21" lon="6"/></trkseg></trk>'),
    'antiméridien': wrap('<trk><trkseg><trkpt lat="-17" lon="179.999"/><trkpt lat="-17" lon="-179.999"/></trkseg></trk>'),
    'waypoints sans nom ni altitude': wrap('<wpt lat="44" lon="6"/><wpt lat="44.005" lon="6"><ele>abc</ele></wpt><trk><trkseg><trkpt lat="44" lon="6"/><trkpt lat="44.01" lon="6"/></trkseg></trk>'),
  };

  for (const [label, text] of Object.entries(cases)) {
    it(`imports « ${label} » without NaN`, () => {
      const result = importLocally(text);
      expect(result.storedPoints.length).toBeGreaterThanOrEqual(2);
      expect(result.timeline.some((item) => item.kind === 'start')).toBe(true);
      expect(nonFiniteNumbers(result)).toEqual([]);
    });
  }
});

describe('parseGpxFile', () => {
  it('reads an ISO-8859-1 file from its bytes (no worker: main-thread path)', async () => {
    const text = '<?xml version="1.0" encoding="ISO-8859-1"?><gpx><trk><name>Col du Pré, Échelles</name><trkseg><trkpt lat="45" lon="7"/><trkpt lat="45.01" lon="7"/></trkseg></trk></gpx>';
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
    const route = await parseGpxFile(new File([bytes], 'ecot.gpx'));
    expect(route.name).toBe('Col du Pré, Échelles');
  });

  it('rejects a refused file with its reason, without a DOMParser retry', async () => {
    const file = new File(['<gpx><trk><trkseg><trkpt lat="45" lon="7"/></trkseg></trk></gpx>'], 'un-point.gpx');
    await expect(parseGpxFile(file)).rejects.toMatchObject({ name: 'GpxParseError', code: 'single-point' });
  });

  it('rejects malformed XML that has no GPX root', async () => {
    const file = new File(['<?xml version="1.0"?><kml><Document>'], 'faux.gpx');
    await expect(parseGpxFile(file)).rejects.toMatchObject({ code: 'not-gpx' });
  });
});

describe('describeGpxImportError', () => {
  it('shows the reason of a refused file', () => {
    expect(describeGpxImportError(new GpxParseError('no-points'))).toBe(GPX_PARSE_ERROR_MESSAGES['no-points']);
    expect(describeGpxImportError(new GpxFileTooLargeError())).toBe('Fichier GPX trop volumineux (50 Mo maximum).');
  });

  it('never shows a developer message for an unexpected failure', () => {
    expect(describeGpxImportError(new TypeError('Cannot read properties of undefined'))).toBe(
      'Impossible d’importer ce GPX. Vérifiez le fichier puis réessayez.',
    );
  });
});
