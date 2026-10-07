import { describe, expect, it } from 'vitest';
import { googleEarthViewFromCamera, offsetGeoPoint } from '@/shared/lib/googleEarthView';
import { mapAimRay, type MapCameraShape } from './googleEarthCamera';

const DEG = Math.PI / 180;
const MAPBOX_FOV = (2 * Math.atan(1 / 3)) / DEG;
const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

function shape(overrides: Partial<MapCameraShape>): MapCameraShape {
  return {
    widthPx: 1600,
    heightPx: 900,
    fovDeg: MAPBOX_FOV,
    bearingDeg: 0,
    pitchDeg: 0,
    padding: ZERO,
    ...overrides,
  };
}

function expectDirection(actual: readonly number[], expected: readonly number[]) {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 9);
}

describe('mapAimRay', () => {
  it('is the Mapbox camera axis and field of view without padding', () => {
    const aim = mapAimRay(shape({ bearingDeg: 90, pitchDeg: 60 }));
    expect(aim.x).toBeCloseTo(800, 9);
    expect(aim.y).toBeCloseTo(450, 9);
    expect(aim.fovYDeg).toBeCloseTo(MAPBOX_FOV, 9);
    // Cap 90° (est), 60° depuis la verticale ; le haut de l'écran monte vers l'est.
    expectDirection(aim.direction, [Math.sin(60 * DEG), 0, -Math.cos(60 * DEG)]);
    expectDirection(aim.up, [Math.cos(60 * DEG), 0, Math.sin(60 * DEG)]);
  });

  it('gives a rotated top-down view the bearing as heading', () => {
    const aim = mapAimRay(shape({ bearingDeg: -45, pitchDeg: 0 }));
    expectDirection(aim.direction, [0, 0, -1]);
    const target = { lon: 6.86, lat: 45.83, altitudeM: 1000 };
    const camera = offsetGeoPoint(target, aim.direction.map((v) => -v * 2000) as [number, number, number]);
    const view = googleEarthViewFromCamera(camera, target, aim.fovYDeg, aim.up)!;
    expect(view.headingDeg).toBeCloseTo(315, 6);
    expect(view.tiltDeg).toBeCloseTo(0, 6);
  });

  it('follows the padding (FreeCam lens shift): the canvas centre looks above the camera axis', () => {
    // Padding haut 600 : axe de Mapbox à y = 750, le canvas couvre 750 px au-dessus, 150 en dessous.
    const focal = 450 / Math.tan((MAPBOX_FOV * DEG) / 2);
    const aim = mapAimRay(shape({ pitchDeg: 85, padding: { top: 600, right: 0, bottom: 0, left: 0 } }));
    const top = Math.atan(-750 / focal);
    const bottom = Math.atan(150 / focal);
    expect(aim.x).toBeCloseTo(800, 9);
    expect(aim.y).toBeCloseTo(750 + focal * Math.tan((top + bottom) / 2), 9);
    expect(aim.fovYDeg).toBeCloseTo((bottom - top) / DEG, 9);
    const tilt = 85 - ((top + bottom) / 2) / DEG;
    expect(tilt).toBeGreaterThan(90);
    expectDirection(aim.direction, [0, Math.sin(tilt * DEG), -Math.cos(tilt * DEG)]);
  });
});
