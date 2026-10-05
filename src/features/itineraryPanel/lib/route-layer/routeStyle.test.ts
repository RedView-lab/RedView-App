import { describe, expect, it } from 'vitest';
import { buildRouteGeoJson, routeOutlineWidthPx, type RouteLayerPoint } from './routeStyle';

const points: RouteLayerPoint[] = [
  { lat: 45, lon: 6, distanceM: 0, elevationM: 800, surface: 'asphalt' },
  { lat: 45.001, lon: 6, distanceM: 111, elevationM: 810, surface: 'asphalt' },
  { lat: 45.002, lon: 6, distanceM: 222, elevationM: 830, surface: 'gravel' },
  { lat: 45.003, lon: 6, distanceM: 333, elevationM: 845, surface: 'gravel' },
];
const base = { color: '#c50000', opacity01: 1, visible: true };

describe('route outline', () => {
  it('is thin: 1.5 px each side of a 5 px trace, within 1–2.5 px', () => {
    expect(routeOutlineWidthPx(5)).toBe(1.5);
    expect(routeOutlineWidthPx(1)).toBe(1);
    expect(routeOutlineWidthPx(20)).toBe(2.5);
  });

  it('surrounds every render mode, slope included', () => {
    const plain = points.map(({ surface: _surface, ...point }) => point);
    expect(buildRouteGeoJson(plain, base, 5).outlineWidthPaint).toBe(8);
    expect(buildRouteGeoJson(points, { ...base, renderMode: 'slope', slopeBands: [] }, 5).outlineWidthPaint).toBe(8);
  });

  it('goes around the surface casing where there is one, the trace elsewhere', () => {
    const spec = buildRouteGeoJson(points, base, 5);
    expect(spec.casingWidthPx).toBeGreaterThan(5);
    expect(spec.outlineWidthPaint).toEqual(['case', spec.casingFilter, spec.casingWidthPx + 3, 8]);
  });
});
