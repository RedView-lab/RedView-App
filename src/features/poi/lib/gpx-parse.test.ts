import { describe, expect, it } from 'vitest';

import { parseGpxText } from './gpx-parse';

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
