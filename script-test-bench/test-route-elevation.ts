import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  LINE_CLEARANCE_M,
  ROUTE_ELEVATED_MIN_ZOOM,
  getRouteElevationContext,
} from '../src/features/itineraryPanel/lib/route-layer/routeElevation';
import type { RouteLayerPoint } from '../src/features/itineraryPanel/lib/route-layer/routeStyle';
import { upsertRouteLayer } from '../src/features/itineraryPanel/lib/route-layer/itineraryLayers';
import { ids } from '../src/features/itineraryPanel/lib/route-layer/constants';

// Contract: every route line reads its altitude from the terrain itself
// (`line-elevation-reference: ground`), i.e. the very DEM tile the 3D mesh is
// drawn with. The former absolute (`sea`) profile, built from bare-earth
// route altitudes, sank under the HD surface model and hid up to half the
// visible trace depending on the zoom level.

const require = createRequire(import.meta.url);
const { validate } = require('../node_modules/mapbox-gl/dist/style-spec/index.cjs');
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

type Layer = { id: string; type: string; source: string; layout: Record<string, unknown>; paint: Record<string, unknown>; filter?: unknown };
class FakeMap {
  terrain: { source: string; exaggeration: number } | null = { source: 'unchanged-dem', exaggeration: 1.5 };
  zoom = 16;
  sourceAdds = 0;
  dataUpdates = 0;
  rejectLayers = false;
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
  addLayer(layer: Layer) {
    if (this.rejectLayers) throw new Error('Style is not done loading');
    this.layers.set(layer.id, layer);
  }
  removeLayer(id: string) { this.layers.delete(id); }
  moveLayer() { /* order is irrelevant here */ }
  getPaintProperty(id: string, name: string) { return this.layers.get(id)!.paint[name]; }
  setPaintProperty(id: string, name: string, value: unknown) { this.layers.get(id)!.paint[name] = value; }
  getLayoutProperty(id: string, name: string) { return this.layers.get(id)!.layout[name]; }
  setLayoutProperty(id: string, name: string, value: unknown) { this.layers.get(id)!.layout[name] = value; }
  setFilter(id: string, filter: unknown) { this.layers.get(id)!.filter = filter; }
  setTerrain() { assert.fail('The 3D map must not change'); }
  queryTerrainElevation() { assert.fail('The trace must not sample the terrain on the CPU'); }
}
const fake = new FakeMap();
const map = fake as unknown as MapboxMap;
const route = points(Array(31).fill(500));
route.forEach((p, i) => { p.surface = i < 10 ? 'gravel' : 'dirt'; });
const lineId = ids('test').line;

function assertAllLayers(reference: string, zOffset: number) {
  assert.ok(fake.layers.size >= 2);
  for (const layer of fake.layers.values()) {
    assert.equal(layer.layout['line-elevation-reference'], reference, layer.id);
    assert.equal(layer.layout['line-z-offset'], zOffset, layer.id);
    assert.equal(layer.paint['line-occlusion-opacity'], 0, layer.id);
  }
}

test('trace, casing and surface patterns all sit on the rendered terrain', () => {
  assert.equal(upsertRouteLayer(map, 'test', route, options), true);
  assertAllLayers('ground', LINE_CLEARANCE_M);
  const style = fake.getStyle();
  const errors = validate({ ...style, sources: Object.fromEntries([...fake.sources].map(([id, spec]) => [id, { type: spec.type, lineMetrics: spec.lineMetrics, data: spec.data }])) });
  assert.deepEqual(errors.map((e: Error) => e.message), []);
});
test('no per-route altitude profile is baked into the data', () => {
  const data = fake.sources.get(ids('test').source)!.data as GeoJSON.FeatureCollection | GeoJSON.Feature;
  const features = data.type === 'FeatureCollection' ? data.features : [data];
  for (const feature of features) assert.equal(feature.properties?.__routeHeights, undefined);
});
test('unchanged replays do not rebuild sources', () => {
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.sourceAdds, 1);
  assert.equal(fake.dataUpdates, 0);
  upsertRouteLayer(map, 'test', route, { ...options, color: '#00ff00' });
  assert.equal(fake.sourceAdds, 1, 'lineMetrics must not cause source recreation');
});
test('DEM quality / exaggeration changes do not touch the trace', () => {
  const updates = fake.dataUpdates;
  fake.terrain = { source: 'other-dem', exaggeration: 2 };
  upsertRouteLayer(map, 'test', route, { ...options, color: '#00ff00' });
  assert.equal(fake.dataUpdates, updates);
  fake.terrain = { source: 'unchanged-dem', exaggeration: 1.5 };
});
test('globe overview and terrain-off remain ordinary draped lines', () => {
  fake.zoom = ROUTE_ELEVATED_MIN_ZOOM - 0.01;
  assert.equal(getRouteElevationContext(map).elevated, false);
  upsertRouteLayer(map, 'test', route, options);
  assertAllLayers('none', 0);
  fake.zoom = ROUTE_ELEVATED_MIN_ZOOM;
  upsertRouteLayer(map, 'test', route, options);
  assertAllLayers('ground', LINE_CLEARANCE_M);
  fake.terrain = null;
  upsertRouteLayer(map, 'test', route, options);
  assertAllLayers('none', 0);
  fake.terrain = { source: 'unchanged-dem', exaggeration: 1.5 };
  fake.zoom = 16;
});
test('visibility toggle and recreated style restore the trace', () => {
  upsertRouteLayer(map, 'test', route, { ...options, visible: false });
  assert.equal(fake.layers.get(lineId)!.layout.visibility, 'none');
  upsertRouteLayer(map, 'test', route, options);
  assert.equal(fake.layers.get(lineId)!.layout.visibility, 'visible');
  fake.sources.clear();
  fake.layers.clear();
  upsertRouteLayer(map, 'test', route, options);
  assertAllLayers('ground', LINE_CLEARANCE_M);
});
test('a refused layer is reported and rebuilt by the next replay', () => {
  fake.sources.clear();
  fake.layers.clear();
  fake.rejectLayers = true;
  assert.equal(upsertRouteLayer(map, 'test', route, options), false);
  assert.equal(fake.layers.has(lineId), false);
  fake.rejectLayers = false;
  // Same inputs: the signature was not recorded, so the line layer is added
  // even though the source already exists.
  assert.equal(upsertRouteLayer(map, 'test', route, options), true);
  assert.ok(fake.layers.has(lineId));
  assertAllLayers('ground', LINE_CLEARANCE_M);
});
console.log(`\n${passed} route elevation regression checks passed.`);
