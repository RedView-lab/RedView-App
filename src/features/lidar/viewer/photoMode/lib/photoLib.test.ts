import { describe, expect, it } from 'vitest';
import { photoSunAt, sunDirectionFromAzAlt } from './sunDirection';
import {
  CLOUD_PRESETS,
  cloudBaseOffsetRange,
  defaultCloudBaseAltitude,
  resolveCloudLayer,
} from './cloudPresets';
import { approximateMie, CLOUD_DROPLET_DIAMETER_UM, mieFitForDiameter } from './phase';
import { cloudLayerSegment, EARTH_RADIUS_M, raySphere, shellAltitude } from './shell';
import { fitLightToBox, fitLightToSquare, lightFrame, projectOrtho } from './shadowFit';
import { invertMat4 } from './mat4';
import { mat4MultiplyInto } from '../../renderer/math';

describe('sunDirectionFromAzAlt', () => {
  it('matches the viewer axes (+X east, +Y up, +Z south)', () => {
    const east = sunDirectionFromAzAlt(90, 0);
    expect(east[0]).toBeCloseTo(1);
    expect(east[1]).toBeCloseTo(0);
    expect(east[2]).toBeCloseTo(0);
    const south = sunDirectionFromAzAlt(180, 30);
    expect(south[0]).toBeCloseTo(0);
    expect(south[1]).toBeCloseTo(0.5);
    expect(south[2]).toBeCloseTo(Math.cos(Math.PI / 6));
  });

  it('rotates true azimuths by the grid bearing of true north', () => {
    const rotated = sunDirectionFromAzAlt(170, 20, 10);
    const reference = sunDirectionFromAzAlt(180, 20, 0);
    rotated.forEach((value, i) => expect(value).toBeCloseTo(reference[i]!));
  });

  it('places the sun high in the south at summer noon in the Alps', () => {
    const sun = photoSunAt({ lat: 45.9, lon: 6.9, timeZone: 'Europe/Paris', trueNorthGridBearingDeg: 0 }, '2026-06-21', '13:30');
    expect(sun.altitudeDeg).toBeGreaterThan(60);
    expect(sun.azimuthDeg).toBeGreaterThan(160);
    expect(sun.azimuthDeg).toBeLessThan(200);
    expect(Math.hypot(...sun.direction)).toBeCloseTo(1);
  });
});

describe('cloud presets', () => {
  it('puts the automatic base among the relief, never on the lowest ground', () => {
    const mountain = defaultCloudBaseAltitude(1500, 2800);
    expect(mountain).toBeGreaterThan(1900);
    expect(mountain).toBeLessThan(2800);
    expect(defaultCloudBaseAltitude(30, 80)).toBe(500);
  });

  it('lets the base come down to wrap the peaks, never onto the valley floor', () => {
    const range = cloudBaseOffsetRange(1500, 2800);
    expect(range.min).toBeLessThan(0);
    const layer = resolveCloudLayer(
      { clouds: 'cumulus', coverage: 50, cloudBaseOffsetM: -100_000 },
      { minAltM: 1500, maxAltM: 2800 },
    );
    expect(layer.baseAltitudeM).toBeGreaterThanOrEqual(1650);
    expect(layer.topAltitudeM - layer.baseAltitudeM).toBe(CLOUD_PRESETS.cumulus.thicknessM);
  });

  it('keeps the extinction of real clouds (visibility inside of tens of metres)', () => {
    for (const preset of Object.values(CLOUD_PRESETS)) {
      expect(preset.extinction).toBeGreaterThanOrEqual(0.04);
      expect(preset.extinction).toBeLessThanOrEqual(0.15);
    }
  });
});

describe('approximate Mie phase function', () => {
  const fit = mieFitForDiameter(CLOUD_DROPLET_DIAMETER_UM);

  it('integrates to 1 over the sphere', () => {
    // μ = 1 − t with t on a log scale: the forward peak (g ≈ 0.99) is
    // narrower than any uniform step.
    const n = 40000;
    const x0 = Math.log(1e-12);
    const x1 = Math.log(2);
    const dx = (x1 - x0) / n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.exp(x0 + (i + 0.5) * dx);
      sum += approximateMie(1 - t, fit) * t * dx;
    }
    expect(sum * 2 * Math.PI).toBeCloseTo(1, 3);
  });

  it('is strongly forward scattering for cloud droplets', () => {
    expect(fit.gHG).toBeGreaterThan(0.98);
    expect(fit.wD).toBeGreaterThan(0.3);
    expect(fit.wD).toBeLessThan(0.6);
    expect(approximateMie(1, fit)).toBeGreaterThan(50 * approximateMie(0, fit));
  });
});

describe('cloud layer shells', () => {
  const up: [number, number, number] = [0, 1, 0];
  const down: [number, number, number] = [0, -1, 0];

  it('measures altitudes along the curved Earth', () => {
    expect(shellAltitude(0, 1000, 0)).toBeCloseTo(1000, 3);
    // 10 km away the surface has dropped by ≈ 7.85 m.
    expect(shellAltitude(10_000, 1000, 0) - 1000).toBeCloseTo(10_000 ** 2 / (2 * EARTH_RADIUS_M), 2);
  });

  it('crosses the layer from below, inside and above', () => {
    expect(cloudLayerSegment(0, 500, 0, up, 1500, 3000, 1e6)).toEqual([1000, 2500].map((v) => expect.closeTo(v, 2)));
    expect(cloudLayerSegment(0, 2000, 0, up, 1500, 3000, 1e6)).toEqual([0, expect.closeTo(1000, 2)]);
    expect(cloudLayerSegment(0, 4000, 0, down, 1500, 3000, 1e6)).toEqual([1000, 2500].map((v) => expect.closeTo(v, 2)));
    expect(cloudLayerSegment(0, 500, 0, down, 1500, 3000, 1e6)).toBeNull();
  });

  it('stops at the ground and at the distance limit', () => {
    const grazing: [number, number, number] = [Math.cos(0.01), Math.sin(0.01), 0];
    const segment = cloudLayerSegment(0, 500, 0, grazing, 1500, 3000, 1e6)!;
    expect(segment[0]).toBeGreaterThan(50_000);
    expect(cloudLayerSegment(0, 500, 0, grazing, 1500, 3000, 20_000)).toBeNull();
    const slightlyDown: [number, number, number] = [Math.cos(-0.05), Math.sin(-0.05), 0];
    expect(cloudLayerSegment(0, 4000, 0, slightlyDown, 1500, 3000, 1e6, 0)).not.toBeNull();
    expect(cloudLayerSegment(0, 500, 0, slightlyDown, 1500, 3000, 1e6, 0)).toBeNull();
  });

  it('keeps metre precision at Earth scale', () => {
    const hit = raySphere(0, 1000, 0, up, 1001)!;
    expect(hit[1]).toBeCloseTo(1, 1);
  });
});

describe('shadow light frames', () => {
  const box = { minX: -500, minY: -100, minZ: -500, maxX: 500, maxY: 300, maxZ: 500 };
  const sun: [number, number, number] = [0.5, 0.6, -0.62];

  it('builds an orthonormal right-handed basis', () => {
    const { right, up, toLight } = lightFrame(sun);
    const d = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(d(right, up)).toBeCloseTo(0);
    expect(d(right, toLight)).toBeCloseTo(0);
    expect(Math.hypot(...right)).toBeCloseTo(1);
    // right × up = toLight
    expect(right[1] * up[2] - right[2] * up[1]).toBeCloseTo(toLight[0]);
    expect(lightFrame([0, 1, 0]).right.every(Number.isFinite)).toBe(true);
  });

  it('frames every corner of the scene, nearest the sun at depth 0', () => {
    const { matrix } = fitLightToBox(sun, box, 4096);
    for (let i = 0; i < 8; i++) {
      const p = [i & 1 ? box.maxX : box.minX, i & 2 ? box.maxY : box.minY, i & 4 ? box.maxZ : box.minZ];
      const [x, y, z] = projectOrtho(matrix, p);
      expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-5);
      expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-5);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(1);
    }
    const near = projectOrtho(matrix, [sun[0] * 400, sun[1] * 400, sun[2] * 400])[2];
    const far = projectOrtho(matrix, [-sun[0] * 400, -sun[1] * 400, -sun[2] * 400])[2];
    expect(near).toBeLessThan(far);
  });

  it('snaps the detail cascade to its texels', () => {
    const a = fitLightToSquare(sun, [10, 0, 10], 100, box, 2048);
    const b = fitLightToSquare(sun, [10.02, 0, 10.01], 100, box, 2048);
    expect(Array.from(b.matrix)).toEqual(Array.from(a.matrix));
    const shifted = fitLightToSquare(sun, [40, 0, 10], 100, box, 2048);
    const dx = (shifted.matrix[12]! - a.matrix[12]!) / (2 / 2048);
    expect(Math.abs(dx - Math.round(dx))).toBeLessThan(1e-3);
  });
});

describe('invertMat4', () => {
  it('inverts a projection-like matrix', () => {
    const m = new Float32Array([1.2, 0, 0, 0, 0, 1.8, 0, 0, 0.1, -0.2, 0, -1, 3, 4, 0.05, 0]);
    const inv = new Float32Array(16);
    expect(invertMat4(inv, m)).toBe(true);
    const id = mat4MultiplyInto(new Float32Array(16), m, inv);
    for (let i = 0; i < 16; i++) expect(id[i]!).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
    expect(invertMat4(inv, new Float32Array(16))).toBe(false);
  });
});
