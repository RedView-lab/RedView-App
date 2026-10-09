import { describe, expect, it } from 'vitest';

import {
  decodeGpxBytes,
  GPX_PARSE_ERROR_MESSAGES,
  GpxParseError,
  parseGpxText,
  type GpxParseErrorCode,
} from './gpx-parse';

const trkpt = (lat: number, lon: number) => `<trkpt lat="${lat}" lon="${lon}"><ele>100</ele></trkpt>`;

describe('parseGpxText', () => {
  it('keeps track segment boundaries (<trkseg>, <trk>)', () => {
    const gpx = `<?xml version="1.0"?><gpx creator="test">
      <trk><name>Jour 1</name>
        <trkseg>${trkpt(44, 6)}${trkpt(44.001, 6)}</trkseg>
        <trkseg>${trkpt(44.1, 6)}${trkpt(44.101, 6)}</trkseg>
      </trk>
      <trk><name>Jour 2</name><trkseg>${trkpt(44.2, 6)}${trkpt(44.201, 6)}</trkseg></trk>
    </gpx>`;

    const route = parseGpxText(gpx);

    expect(route.pointsKind).toBe('track');
    expect(route.points).toHaveLength(6);
    expect(route.segmentStarts).toEqual([2, 4]);
  });

  it('reports a single-segment track and a route (<rtept>) without segment boundaries', () => {
    const track = parseGpxText(`<gpx><trk><trkseg>${trkpt(44, 6)}${trkpt(44.001, 6)}${trkpt(44.002, 6)}</trkseg></trk></gpx>`);
    expect(track.segmentStarts).toEqual([]);

    const route = parseGpxText('<gpx><rte><rtept lat="44" lon="6"/><rtept lat="44.05" lon="6.02"/></rte></gpx>');
    expect(route.pointsKind).toBe('route');
    expect(route.segmentStarts).toEqual([]);
  });
});

const gpx = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test">${body}</gpx>`;
const segment = (...points: string[]) => `<trk><trkseg>${points.join('')}</trkseg></trk>`;

function expectParseError(text: string, code: GpxParseErrorCode) {
  let caught: unknown;
  try {
    parseGpxText(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GpxParseError);
  expect((caught as GpxParseError).code).toBe(code);
  expect((caught as GpxParseError).message).toBe(GPX_PARSE_ERROR_MESSAGES[code]);
}

function expectNoNaN(value: unknown) {
  const json = JSON.stringify(value, (_key, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `!${v}` : v));
  expect(json).not.toMatch(/"!(NaN|Infinity|-Infinity)"/);
}

describe('parseGpxText — fichiers limites', () => {
  it('refuses a file that is not a GPX, with its reason', () => {
    expectParseError('<html><body>pas un gpx</body></html>', 'not-gpx');
    expectParseError('', 'not-gpx');
    expectParseError('{"type":"FeatureCollection"}', 'not-gpx');
    // <gpxtpx:…> (extension Garmin) n'est pas une racine <gpx>.
    expectParseError('<gpxtpx:TrackPointExtension/>', 'not-gpx');
  });

  it('refuses a track of a single point', () => {
    expectParseError(gpx(segment(trkpt(44, 6))), 'single-point');
  });

  it('refuses a GPX without any point (empty segments, waypoints only)', () => {
    expectParseError(gpx('<trk><trkseg></trkseg><trkseg/></trk>'), 'no-points');
    expectParseError(gpx('<wpt lat="44" lon="6"><name>Col</name></wpt>'), 'no-points');
  });

  it('refuses a track whose points are all at the same place', () => {
    expectParseError(gpx(segment(trkpt(44, 6), trkpt(44, 6), trkpt(44, 6))), 'zero-length');
  });

  it('ignores empty segments around real ones without inventing a break', () => {
    const route = parseGpxText(gpx(`<trk><trkseg></trkseg><trkseg>${trkpt(44, 6)}${trkpt(44.01, 6)}</trkseg><trkseg/></trk>`));
    expect(route.points).toHaveLength(2);
    expect(route.segmentStarts).toEqual([]);
  });

  it('reads a track without any elevation as a 2D route (null, never NaN)', () => {
    const route = parseGpxText(gpx(segment('<trkpt lat="44" lon="6"></trkpt>', '<trkpt lat="44.01" lon="6"/>')));
    expect(route.points.map((point) => point.elevationM)).toEqual([null, null]);
    expectNoNaN(route);
  });

  it('reads a <rte>-only file as a route to be routed', () => {
    const route = parseGpxText(gpx('<rte><name>Boucle</name><rtept lat="44" lon="6"/><rtept lat="44.1" lon="6.1"><ele>800</ele></rtept></rte>'));
    expect(route.pointsKind).toBe('route');
    expect(route.name).toBe('Boucle');
    expect(route.points).toHaveLength(2);
  });

  it('skips points with missing or out-of-range coordinates', () => {
    const route = parseGpxText(gpx(segment(
      '<trkpt lat="944" lon="6"/>',
      '<trkpt lat="44" lon="986"/>',
      '<trkpt lat="abc" lon="6"/>',
      '<trkpt lon="6"/>',
      trkpt(44, 6),
      trkpt(44.01, 6),
    )));
    expect(route.points.map((point) => [point.lat, point.lon])).toEqual([[44, 6], [44.01, 6]]);
    expect(route.points[1]!.distanceM).toBeCloseTo(1112, 0);
  });

  it('reads decimal commas, entities and odd attribute quoting', () => {
    const route = parseGpxText(gpx(segment(
      `<trkpt lon='6' lat = '44'><ele>12,5</ele></trkpt>`,
      '<trkpt\n  lat="44,01"\n  lon="6"><ele>&#49;3</ele></trkpt>',
    )));
    expect(route.points.map((point) => [point.lat, point.elevationM])).toEqual([[44, 12.5], [44.01, 13]]);
  });

  it('reads namespace-prefixed GPX (<gpx:trkpt>)', () => {
    const route = parseGpxText(
      '<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1"><gpx:trk><gpx:name>Préfixé</gpx:name><gpx:trkseg>'
      + '<gpx:trkpt lat="44" lon="6"><gpx:ele>100</gpx:ele></gpx:trkpt><gpx:trkpt lat="44.01" lon="6"/>'
      + '</gpx:trkseg></gpx:trk></gpx:gpx>',
    );
    expect(route.name).toBe('Préfixé');
    expect(route.points).toHaveLength(2);
    expect(route.points[0]!.elevationM).toBe(100);
  });

  it('keeps the points read before the end of a truncated file', () => {
    const truncated = `${gpx(segment(trkpt(44, 6), trkpt(44.01, 6))).replace('</trkseg></trk></gpx>', '')}<trkpt lat="44.02" lon="6"><ele>1`;
    const route = parseGpxText(truncated);
    expect(route.points.map((point) => point.lat)).toEqual([44, 44.01, 44.02]);
    expectNoNaN(route);
  });

  it('never takes a waypoint or author name for the track name, and caps its length', () => {
    const track = segment(trkpt(44, 6), trkpt(44.01, 6));
    expect(parseGpxText(gpx(`<metadata><author><name>Alice</name></author></metadata>${track}<wpt lat="44" lon="6"><name>Col</name></wpt>`)).name).toBeNull();
    expect(parseGpxText(gpx(`<metadata><name>Nom du fichier</name></metadata>${track}`)).name).toBe('Nom du fichier');
    const long = parseGpxText(gpx(`<trk><name><![CDATA[${'x'.repeat(5000)}]]></name><trkseg>${trkpt(44, 6)}${trkpt(44.01, 6)}</trkseg></trk>`)).name!;
    expect(long.length).toBeLessThanOrEqual(200);
  });

  it('leaves invalid numeric entities as text instead of throwing', () => {
    const route = parseGpxText(gpx(`<trk><name>A &#99999999; B &amp; C</name><trkseg>${trkpt(44, 6)}${trkpt(44.01, 6)}</trkseg></trk>`));
    expect(route.name).toBe('A &#99999999; B & C');
  });

  it('parses self-closing points in linear time (was quadratic)', () => {
    // Rapport de temps entre N et 8N points, pas une durée absolue (le test
    // tourne en parallèle d'autres étapes) : ×8 en linéaire, ×64 pour
    // l'ancienne lecture quadratique (3,9 s pour 32 000 points).
    const build = (count: number) => gpx(segment(
      Array.from({ length: count }, (_, i) => `<trkpt lat="${(44 + i * 1e-5).toFixed(5)}" lon="6"/>`).join(''),
    ));
    const bestOf3 = (text: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        parseGpxText(text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = build(5_000);
    const large = build(40_000);
    expect(parseGpxText(large).points).toHaveLength(40_000);
    const ratio = bestOf3(large) / Math.max(bestOf3(small), 0.5);
    expect(ratio).toBeLessThan(24);
  }, 60_000);

  it('parses a 50 MB file', () => {
    const point = (i: number) => `<trkpt lat="${(44 + i * 1e-5).toFixed(6)}" lon="6.000000"><ele>${(100 + (i % 50)).toFixed(1)}</ele><time>2026-07-01T06:00:00Z</time></trkpt>\n`;
    const chunks: string[] = [];
    let size = 0;
    for (let i = 0; size < 50 * 1024 * 1024; i += 1) {
      const chunk = point(i);
      chunks.push(chunk);
      size += chunk.length;
    }
    const route = parseGpxText(gpx(segment(chunks.join(''))));
    expect(route.points.length).toBe(chunks.length);
    expect(route.points.at(-1)!.elevationM).toBe(100 + ((chunks.length - 1) % 50));
    // Pas de chrono (la linéarité est vérifiée au-dessus) : un délai large
    // pour une machine chargée.
  }, 120_000);
});

describe('decodeGpxBytes', () => {
  const name = 'Étape à Thônes';
  const body = (declaration: string) => `${declaration}<gpx><trk><name>${name}</name><trkseg>${trkpt(44, 6)}${trkpt(44.01, 6)}</trkseg></trk></gpx>`;
  const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

  it('reads UTF-8, with or without a BOM', () => {
    const utf8 = new TextEncoder().encode(body('<?xml version="1.0" encoding="UTF-8"?>'));
    expect(parseGpxText(decodeGpxBytes(utf8)).name).toBe(name);
    expect(parseGpxText(decodeGpxBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).name).toBe(name);
  });

  it('reads a declared ISO-8859-1 file', () => {
    const bytes = latin1(body('<?xml version="1.0" encoding="ISO-8859-1"?>'));
    expect(parseGpxText(decodeGpxBytes(bytes)).name).toBe(name);
  });

  it('reads an undeclared Latin-1 file instead of producing replacement characters', () => {
    const bytes = latin1(body('<?xml version="1.0"?>'));
    expect(parseGpxText(decodeGpxBytes(bytes)).name).toBe(name);
  });

  it('reads UTF-16 with a BOM', () => {
    const text = body('<?xml version="1.0" encoding="UTF-16"?>');
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i += 1) bytes[2 + i * 2] = text.charCodeAt(i);
    expect(parseGpxText(decodeGpxBytes(bytes)).name).toBe(name);
  });

  it('falls back to detection on an unknown declared encoding', () => {
    const bytes = new TextEncoder().encode(body('<?xml version="1.0" encoding="x-unknown-42"?>'));
    expect(parseGpxText(decodeGpxBytes(bytes)).name).toBe(name);
  });
});
