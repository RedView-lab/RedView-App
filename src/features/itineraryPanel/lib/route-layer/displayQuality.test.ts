import { describe, expect, it } from 'vitest';
import type { Itinerary } from '../../types';
import { simplifyPointsByQuality } from '../routes/simplify-route';
import { resolveRouteDisplayPoints, resolveRouteDisplayPreset } from './displayQuality';

type Route = NonNullable<Itinerary['gpxRoute']>;

/** Lacets : 10 jambes de 300 m reliées par des épingles, un point tous les 5 m. */
function switchbacks(): Route['points'] {
  const points: Route['points'] = [];
  const mPerDeg = 111_320;
  let x = 0;
  let y = 0;
  let distanceM = 0;
  const push = (px: number, py: number) => {
    const last = points[points.length - 1];
    if (last) distanceM += Math.hypot(px - (last.lon * mPerDeg * 0.7), py - (last.lat * mPerDeg));
    points.push({ lat: py / mPerDeg, lon: px / (mPerDeg * 0.7), distanceM, elevationM: 800 + distanceM * 0.08 });
  };
  for (let leg = 0; leg < 10; leg++) {
    const dir = leg % 2 === 0 ? 1 : -1;
    for (let s = 0; s < 300; s += 5) push(x + dir * s, y);
    x += dir * 300;
    for (let k = 0; k < 12; k++) {
      const a = -Math.PI / 2 + (k / 12) * Math.PI;
      push(x + dir * 18 * Math.cos(a), y + 18 + 18 * Math.sin(a));
    }
    y += 36;
  }
  return points;
}

describe('resolveRouteDisplayPreset', () => {
  it('auto: maximum only in 3D on the HD relief, fast otherwise', () => {
    expect(resolveRouteDisplayPreset('auto', { threeD: false, hdTerrain: false })).toBe('default');
    expect(resolveRouteDisplayPreset('auto', { threeD: true, hdTerrain: false })).toBe('default');
    expect(resolveRouteDisplayPreset('auto', { threeD: false, hdTerrain: true })).toBe('default');
    expect(resolveRouteDisplayPreset('auto', { threeD: true, hdTerrain: true })).toBe('max');
  });

  it('keeps a chosen preset whatever the view', () => {
    expect(resolveRouteDisplayPreset('balanced', { threeD: true, hdTerrain: true })).toBe('balanced');
    expect(resolveRouteDisplayPreset('max', { threeD: false, hdTerrain: false })).toBe('max');
  });

  it('reads anything else (absent, old « expert », hostile file) as auto', () => {
    for (const value of [undefined, null, 'expert', '__proto__']) {
      expect(resolveRouteDisplayPreset(value, { threeD: true, hdTerrain: true })).toBe('max');
      expect(resolveRouteDisplayPreset(value, { threeD: false, hdTerrain: true })).toBe('default');
    }
  });
});

describe('resolveRouteDisplayPoints', () => {
  const original = switchbacks();
  // GPX importé : tracé de travail simplifié en « rapide », original conservé.
  const imported: Route = {
    name: null,
    source: 'gpx',
    points: simplifyPointsByQuality(original, 'default'),
    originalPoints: original,
  };

  it('draws the working route when the preset asks no more detail', () => {
    expect(resolveRouteDisplayPoints(imported, 'default')).toBe(imported.points);
  });

  it('redraws an imported track from its original when the preset asks more', () => {
    const drawn = resolveRouteDisplayPoints(imported, 'max');
    expect(drawn.length).toBeGreaterThan(imported.points.length * 3);
    expect(drawn.length).toBeLessThan(original.length);
    expect(drawn[0]).toMatchObject({ lat: original[0]!.lat, lon: original[0]!.lon });
    expect(drawn[drawn.length - 1]).toMatchObject({ lat: original.at(-1)!.lat, lon: original.at(-1)!.lon });
  });

  it('draws a computed (full resolution) route as is', () => {
    const routed: Route = { name: null, source: 'brouter', points: original, originalPoints: original.slice() };
    expect(resolveRouteDisplayPoints(routed, 'default')).toBe(routed.points);
    expect(resolveRouteDisplayPoints(routed, 'max')).toBe(routed.points);
    expect(resolveRouteDisplayPoints({ name: null, points: original }, 'max')).toBe(original);
  });
});
