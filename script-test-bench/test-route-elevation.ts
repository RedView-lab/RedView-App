import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Map as MapboxMap } from 'mapbox-gl';
import { applyRouteElevationProfile, getRouteElevationContext, ROUTE_PROFILE_Z_OFFSET } from '../src/features/itineraryPanel/lib/route-layer/routeElevation';
import { buildRouteGeoJson, type RouteLayerPoint, type RouteLayerRenderSpec } from '../src/features/itineraryPanel/lib/route-layer/routeStyle';
import { upsertRouteLayer } from '../src/features/itineraryPanel/lib/route-layer/itineraryLayers';
import { ids } from '../src/features/itineraryPanel/lib/route-layer/constants';

const require = createRequire(import.meta.url);
const { expression, latest, validate } = require('../node_modules/mapbox-gl/dist/style-spec/index.cjs');
const options = { color: '#ff0000', opacity01: 1, visible: true, traceWidthPx: 8 };
let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}
function points(heights: (number | null)[]): RouteLayerPoint[] {
  return heights.map((elevationM, i) => ({ lon: 6 + i * 0.00012704, lat: 45, elevationM }));
}
function features(spec: RouteLayerRenderSpec) {
  return spec.data.type === 'FeatureCollection' ? spec.data.features : [spec.data];
}
function heights(spec: RouteLayerRenderSpec, index = 0): number[] {
  return features(spec)[index].properties!.__routeHeights;
}
function profile(route: RouteLayerPoint[], scale = 1.5) {
  const spec = buildRouteGeoJson(route, options, 8);
  assert.ok(applyRouteElevationProfile(spec, route, scale));
  return spec;
}
const compiled = expression.createPropertyExpression(ROUTE_PROFILE_Z_OFFSET, latest.layout_line['line-z-offset']);

test('native renderer accepts and interpolates the absolute-height expression', () => {
  assert.equal(compiled.result, 'success');
  for (const [progress, expected] of [[0, 100], [0.25, 150], [0.5, 200], [1, 300]]) {
    assert.equal(compiled.value.evaluate({ zoom: 16, lineProgress: progress }, {
      type: 2, properties: { __routeHeights: [100, 200, 300] },
    }), expected);
  }
});
test('flat trail stays flat and uses the existing terrain scale only once', () => {
  assert.ok(heights(profile(points(Array(101).fill(500)))).every(h => Math.abs(h - 750.8) < 1e-8));
});
test('isolated altitude spike is removed from the visual profile', () => {
  const values = Array(101).fill(500);
  values[50] = 560;
  assert.ok(Math.max(...heights(profile(points(values)))) < 752);
});
test('sustained climbs and both endpoints remain, not a constant-altitude line', () => {
  const h = heights(profile(points(Array.from({ length: 101 }, (_, i) => 500 + i))));
  assert.equal(h[0], 750.8);
  assert.equal(h.at(-1), 900.8);
  assert.ok(h.every((value, i) => i === 0 || value >= h[i - 1]));
});
test('GPX coordinates, raw elevations and slope colors are untouched', () => {
  const route = points([500, 505, 590, 515, 520]);
  const original = structuredClone(route);
  const spec = buildRouteGeoJson(route, { ...options, renderMode: 'slope', slopeBands: [{ id: 'a', minDeg: -90, maxDeg: 90, color: '#ff0000' }] }, 8);
  const geometry = structuredClone(features(spec)[0].geometry);
  const gradient = structuredClone(spec.lineGradientPaint);
  assert.ok(applyRouteElevationProfile(spec, route, 1.5));
  assert.deepEqual(route, original);
  assert.deepEqual(features(spec)[0].geometry, geometry);
  assert.deepEqual(spec.lineGradientPaint, gradient);
});
test('missing and sentinel elevations interpolate without a drop to sea level', () => {
  const h = heights(profile(points([null, 500, -32768, null, 520, null])));
  assert.ok(h.every(value => Number.isFinite(value) && value >= 750.8 && value <= 780.8));
  const route = points([null, -9999, null]);
  assert.equal(applyRouteElevationProfile(buildRouteGeoJson(route, options, 8), route, 1.5), false);
});
test('duplicate coordinates and zero-length routes produce finite heights', () => {
  const route = points([500, 510, 520]).map(p => ({ ...p, lon: 6 }));
  assert.ok(heights(profile(route)).every(Number.isFinite));
});
test('all surface runs share continuous heights with their casing and patterns', () => {
  const route = points(Array.from({ length: 51 }, (_, i) => 500 + i));
  route.forEach((p, i) => { p.surface = i < 10 ? 'paved' : i < 20 ? 'gravel' : i < 30 ? 'dirt' : 'sand'; });
  const spec = profile(route);
  assert.equal(features(spec).length, 4);
  for (let i = 1; i < 4; i += 1) assert.equal(heights(spec, i - 1).at(-1), heights(spec, i)[0]);
});
test('100k-point profiles have bounded sampling cost', () => {
  const route = points(Array.from({ length: 100_000 }, (_, i) => 500 + Math.sin(i / 1000) * 50));
  const start = performance.now();
  const spec = profile(route);
  assert.ok(heights(spec).length <= 16_384);
  assert.ok(heights(spec).every(Number.isFinite));
  console.log(`  100k vertices: ${(performance.now() - start).toFixed(1)} ms; ${heights(spec).length} height samples`);
});

type Layer = { id: string; type: string; source: string; layout: Record<string, unknown>; paint: Record<string, unknown>; filter?: unknown };
class FakeMap {
  terrain: { source: string; exaggeration: number } | null = { source: 'unchanged-dem', exaggeration: 1.5 };
  zoom = 16;
  sourceAdds = 0;
  dataUpdates = 0;
  layers = new Map<string, Layer>();
  sources = new Map<string, { type: 'geojson'; lineMetrics: boolean; data: unknown; setData: (data: unknown) => void }>();
  getTerrain() { return this.terrain; }
  getZoom() { return this.zoom; }
  getStyle() { return { version: 8, sources: Object.fromEntries(this.sources), layers: [...this.layers.values()] }; }
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, spec: { type: 'geojson'; lineMetrics: boolean; data: unknown }) {
    this.sourceAdds += 1;
    this.sources.set(id, { ...spec, setData: (data: unknown) => { this.dataUpdates += 1; this.sources.get(id)!.data = data; } });
  }
  removeSource(id: string) { this.sources.delete(id); }
  getLayer(id: string) { return this.layers.get(id); }
  addLayer(layer: Layer) { this.layers.set(layer.id, layer); }
  removeLayer(id: string) { this.layers.delete(id); }
  getPaintProperty(id: string, name: string) { return this.layers.get(id)!.paint[name]; }
  setPaintProperty(id: string, name: string, value: unknown) { this.layers.get(id)!.paint[name] = value; }
  getLayoutProperty(id: string, name: string) { return this.layers.get(id)!.layout[name]; }
  setLayoutProperty(id: string, name: string, value: unknown) { this.layers.get(id)!.layout[name] = value; }
  setFilter(id: string, filter: unknown) { this.layers.get(id)!.filter = filter; }
  setTerrain() { assert.fail('The 3D map must not change'); }
  queryTerrainElevation() { assert.fail('The visual profile must not depend on canopy tiles'); }
}
const fake = new FakeMap();
const map = fake as unknown as MapboxMap;
const route = points(Array(31).fill(500));
route.forEach((p, i) => { p.surface = i < 10 ? 'gravel' : 'dirt'; });
const lineId = ids('test').line;

test('main trail, casing and patterns all use the same absolute heights and visibility', () => {
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.size, 4);
  for (const layer of fake.layers.values()) {
    assert.equal(layer.layout['line-elevation-reference'], 'sea');
    assert.deepEqual(layer.layout['line-z-offset'], ROUTE_PROFILE_Z_OFFSET);
    assert.equal(layer.paint['line-occlusion-opacity'], 1);
  }
  const style = fake.getStyle();
  const errors = validate({ ...style, sources: Object.fromEntries([...fake.sources].map(([id, spec]) => [id, { type: spec.type, lineMetrics: spec.lineMetrics, data: spec.data }])) });
  assert.deepEqual(errors.map((e: Error) => e.message), []);
});
test('unchanged replays do not rebuild sources or resample terrain', () => {
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.sourceAdds, 1);
  assert.equal(fake.dataUpdates, 0);
  upsertRouteLayer(map, 'test', route, { ...options, color: '#00ff00' });
  assert.equal(fake.sourceAdds, 1, 'lineMetrics must not cause source recreation');
});
test('terrain scale changes refresh heights, not the terrain', () => {
  fake.terrain!.exaggeration = 2;
  upsertRouteLayer(map, 'test', route, options);
  const data = fake.sources.get(ids('test').source)!.data as GeoJSON.FeatureCollection;
  assert.equal(data.features[0].properties!.__routeHeights[0], 1000.8);
});
test('globe overview and terrain-off remain ordinary visible 2D lines', () => {
  fake.zoom = 4;
  assert.equal(getRouteElevationContext(map).scale, null);
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.get(lineId)!.layout['line-elevation-reference'], 'none');
  assert.equal(fake.layers.get(lineId)!.layout['line-z-offset'], 0);
  fake.zoom = 16;
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.get(lineId)!.layout['line-elevation-reference'], 'sea');
  fake.terrain = null;
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.get(lineId)!.layout['line-elevation-reference'], 'none');
});
test('visibility toggle and recreated style restore the smooth trail', () => {
  fake.terrain = { source: 'unchanged-dem', exaggeration: 1.5 };
  upsertRouteLayer(map, 'test', route, { ...options, visible: false });
  assert.equal(fake.layers.get(lineId)!.layout.visibility, 'none');
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.get(lineId)!.layout.visibility, 'visible');
  fake.sources.clear();
  fake.layers.clear();
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.get(lineId)!.layout['line-elevation-reference'], 'sea');
});
console.log(`\n${passed} route elevation regression checks passed.`);
