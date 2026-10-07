import { describe, expect, it } from 'vitest';
import { toWgs84, trueNorthGridBearingDeg } from '../lib/coordConvert';
import { CameraController } from './camera';
import { googleEarthViewFromViewer } from './googleEarth';
import type { ViewerRouteSceneParams } from './route/types';

const DEG = Math.PI / 180;

// Tuile Lambert-93 loin du méridien central (3°E) : convergence ≈ +3°.
const cx = 1_000_500;
const cy = 6_300_500;
const cz = 1200;
const scene: ViewerRouteSceneParams = {
  bounds: { minX: cx - 500, maxX: cx + 500, minY: cy - 500, maxY: cy + 500, minZ: cz - 100, maxZ: cz + 100 },
  crs: 'LAMB93',
  centerX: cx,
  centerY: cy,
  centerZ: cz,
  // Sans grille : MNT plat à l'altitude du centre (y = 0).
  heightGrid: null,
};

function fakeCanvas(): HTMLCanvasElement {
  return { width: 1600, height: 900, clientWidth: 1600, clientHeight: 900, addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLCanvasElement;
}

function withWindow<T>(run: () => T): T {
  const g = globalThis as { window?: unknown };
  const previous = g.window;
  g.window = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    return run();
  } finally {
    g.window = previous;
  }
}

function lookCamera(eye: [number, number, number], yaw: number, pitch: number): CameraController {
  return withWindow(() => {
    const camera = new CameraController(fakeCanvas());
    camera.enterLook(eye, { yaw, pitch, fovX: 90 * DEG });
    // Fin du vol vers le point de vue.
    for (let t = 0; t <= 5000; t += 16) camera.update(t);
    return camera;
  });
}

const convergence = trueNorthGridBearingDeg(cx, cy, 'LAMB93');

describe('googleEarthViewFromViewer', () => {
  it('turns grid north into true north (meridian convergence) and keeps the field of view', () => {
    expect(Math.abs(convergence)).toBeGreaterThan(2);
    // Regard horizontal vers le nord de la grille : la visée ne touche pas le sol, point en l'air.
    const camera = lookCamera([0, 100, 0], 0, 0);
    const view = googleEarthViewFromViewer(camera, scene)!;
    expect(view.headingDeg).toBeCloseTo((360 - convergence) % 360, 3);
    expect(view.tiltDeg).toBeCloseTo(90, 6);
    expect(view.fovYDeg).toBeCloseTo(camera.getFovY() / DEG, 9);
    expect(view.fovYDeg).toBeCloseTo((2 * Math.atan(Math.tan(45 * DEG) * 900 / 1600)) / DEG, 9);
    expect(view.target.altitudeM).toBeCloseTo(cz + 100, 6);
  });

  it('aims at the ground under the line of sight in look-around mode', () => {
    // 50 m au-dessus du MNT, vers l'est de la grille, 45° sous l'horizon.
    const camera = lookCamera([0, 50, 0], 90 * DEG, -45 * DEG);
    const view = googleEarthViewFromViewer(camera, scene)!;
    expect(view.target.altitudeM).toBeCloseTo(cz, 1);
    expect(view.headingDeg).toBeCloseTo(90 - convergence, 2);
    // Échelle de la projection : < 0,1 % sur la distance horizontale, donc sur l'angle.
    expect(Math.abs(view.tiltDeg - 45)).toBeLessThan(0.05);
    expect(Math.abs(view.distanceM - 50 * Math.SQRT2)).toBeLessThan(0.1);
  });

  it('aims at the orbit target, at its altitude', () => {
    const camera = withWindow(() => new CameraController(fakeCanvas()));
    camera.setPose({ targetX: 10, targetY: 5, targetZ: -20, radius: 800, theta: 30 * DEG, phi: 50 * DEG });
    const view = googleEarthViewFromViewer(camera, scene)!;
    const [lon, lat] = toWgs84(cx + 10, cy + 20, 'LAMB93');
    expect(view.target.lon).toBeCloseTo(lon, 9);
    expect(view.target.lat).toBeCloseTo(lat, 9);
    expect(view.target.altitudeM).toBeCloseTo(cz + 5, 6);
    expect(Math.abs(view.distanceM - 800)).toBeLessThan(800 * 1e-3);
    // phi = angle depuis la verticale haute de l'œil autour de la cible = inclinaison Google Earth.
    expect(Math.abs(view.tiltDeg - 50)).toBeLessThan(0.05);
    expect(view.fovYDeg).toBeCloseTo(45, 9);
  });
});
