import assert from 'node:assert/strict';

// Node has no ImageData: the encoder only needs width/height/data.
class NodeImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as unknown as { ImageData: unknown }).ImageData = NodeImageData;

const { encodeDem } = await import('../../src/features/altitude/lib/altitude-dem-source');
type Dem = Parameters<typeof encodeDem>[0];

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}

/** DEMData-shaped grid (1 px border) filled by f(x, y) in DEM pixel coordinates. */
function dem(dim: number, f: (x: number, y: number) => number): Dem {
  const stride = dim + 2;
  const floatView = new Float32Array(stride * stride);
  for (let y = -1; y <= dim; y += 1) {
    for (let x = -1; x <= dim; x += 1) floatView[(y + 1) * stride + x + 1] = f(x, y);
  }
  return { dim, stride, floatView };
}
function decode(image: { data: Uint8ClampedArray; width: number }, x: number, y: number): number {
  const o = (y * image.width + x) * 4;
  return -10000 + (image.data[o] * 65536 + image.data[o + 1] * 256 + image.data[o + 2]) * 0.1;
}

test('exact tile decodes back to the DEM within the 0.1 m Terrain-RGB step', () => {
  const d = dem(256, (x, y) => 120.37 + x * 7.1 + y * 3.3 + (x * y) % 17);
  const image = encodeDem(d);
  assert.equal(image.width, 256);
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [128, 77], [255, 255]]) {
    assert.ok(Math.abs(decode(image, x, y) - d.floatView[(y + 1) * d.stride + x + 1]) <= 0.05 + 1e-6);
  }
});
test('every pixel is opaque (alpha is not part of the decode)', () => {
  const image = encodeDem(dem(16, () => 500));
  for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], 255);
});
test('ancestor crop lands on the right quadrant (bilinear, pixel-centre aligned)', () => {
  // Planar DEM: a crop must reproduce the plane at the child's pixel centres.
  const plane = (x: number, y: number) => 1000 + 2 * x - 3 * y;
  const d = dem(256, plane);
  for (const [dz, qx, qy] of [[1, 1, 0], [1, 0, 1], [2, 3, 2], [3, 5, 7]]) {
    const image = encodeDem(d, dz, qx, qy);
    const scale = 1 / (1 << dz);
    for (const [px, py] of [[0, 0], [100, 50], [255, 255]]) {
      const sx = qx * 256 * scale + (px + 0.5) * scale - 0.5;
      const sy = qy * 256 * scale + (py + 0.5) * scale - 0.5;
      assert.ok(Math.abs(decode(image, px, py) - plane(sx, sy)) <= 0.06, `dz=${dz} q=${qx},${qy} p=${px},${py}`);
    }
  }
});
test('below-datum and invalid samples clamp instead of wrapping', () => {
  const image = encodeDem(dem(4, (x) => (x === 0 ? -20000 : x === 1 ? Number.NaN : x === 2 ? -50 : 1e7)));
  assert.equal(decode(image, 0, 0), -10000);
  assert.equal(decode(image, 1, 0), -10000);
  assert.ok(Math.abs(decode(image, 2, 0) + 50) <= 0.05);
  assert.ok(decode(image, 3, 0) > 1_600_000);
});
test('a 512 px tile encodes in a few milliseconds', () => {
  const d = dem(512, (x, y) => x + y);
  const start = performance.now();
  for (let i = 0; i < 10; i += 1) encodeDem(d);
  const ms = (performance.now() - start) / 10;
  console.log(`  512 px tile: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 25);
});
console.log(`\n${passed} altitude DEM source checks passed.`);
