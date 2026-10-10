// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { parseGpxTextWithDomParser } from './gpx-loader';
import { parseGpxText } from './gpx-parse';

/** GPX exporté par RedView : point de parcours avec nom lisible et catégorie exacte. */
const REDVIEW_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RedView" xmlns="http://www.topografix.com/GPX/1/1" xmlns:redview="https://redview.tech/gpx/1">
  <wpt lat="45.005" lon="6.001">
    <name>BOU_D03_7-19_La Mie</name>
    <cmt>La Mie Câline</cmt>
    <type>Food</type>
    <extensions><redview:category>bakeries</redview:category></extensions>
  </wpt>
  <trk><name>Ultra</name><trkseg>
    <trkpt lat="45" lon="6"><ele>100</ele></trkpt>
    <trkpt lat="45.01" lon="6"><ele>110</ele></trkpt>
  </trkseg></trk>
</gpx>`;

describe('analyseur de repli DOMParser (B1-3)', () => {
  it('lit les mêmes champs que l’analyseur rapide, catégorie RedView et commentaire compris', () => {
    const fast = parseGpxText(REDVIEW_GPX);
    const fallback = parseGpxTextWithDomParser(REDVIEW_GPX);
    expect(fallback.waypoints).toEqual(fast.waypoints);
    expect(fallback.waypoints?.[0]).toMatchObject({ cmt: 'La Mie Câline', redviewCategory: 'bakeries' });
    expect(fallback.points.map((point) => point.lat)).toEqual(fast.points.map((point) => point.lat));
    expect(fallback.creator).toBe(fast.creator);
  });
});
