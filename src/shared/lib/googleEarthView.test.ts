import { describe, expect, it } from 'vitest';
import {
  buildGoogleEarthUrl,
  enuBetween,
  googleEarthViewFromCamera,
  isGoogleEarthShortcut,
  offsetGeoPoint,
  type GeoPoint,
} from './googleEarthView';

const DEG = Math.PI / 180;

describe('enuBetween / offsetGeoPoint', () => {
  it('uses the WGS84 radii of curvature (M = 6 367 381.8 m, N = 6 388 838.3 m at 45°N)', () => {
    const north = enuBetween({ lon: 4, lat: 44.995, altitudeM: 0 }, { lon: 4, lat: 45.005, altitudeM: 0 });
    expect(north[1]).toBeCloseTo(6367381.8 * 0.01 * DEG, 2);
    const east = enuBetween({ lon: 3.995, lat: 45, altitudeM: 0 }, { lon: 4.005, lat: 45, altitudeM: 0 });
    expect(east[0]).toBeCloseTo(6388838.3 * Math.cos(45 * DEG) * 0.01 * DEG, 2);
  });

  it('round-trips an offset to the millimetre', () => {
    const from: GeoPoint = { lon: 6.8652, lat: 45.8326, altitudeM: 1035 };
    const enu: [number, number, number] = [-7321.4, 9876.5, 3770.25];
    const back = enuBetween(from, offsetGeoPoint(from, enu));
    for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - enu[i])).toBeLessThan(1e-3);
  });

  it('crosses the antimeridian', () => {
    const enu = enuBetween({ lon: 179.999, lat: -41, altitudeM: 0 }, { lon: -179.999, lat: -41, altitudeM: 0 });
    expect(enu[0]).toBeGreaterThan(0);
    expect(enu[0]).toBeLessThan(200);
  });
});

describe('googleEarthViewFromCamera', () => {
  const target: GeoPoint = { lon: 2.2985, lat: 48.8555, altitudeM: 35 };

  it('looks straight down from above the target (tilt 0, north up)', () => {
    const view = googleEarthViewFromCamera({ ...target, altitudeM: 1535 }, target, 35)!;
    expect(view.distanceM).toBeCloseTo(1500, 6);
    expect(view.tiltDeg).toBeCloseTo(0, 9);
    expect(view.headingDeg).toBe(0);
    expect(view.target).toBe(target);
  });

  it('gives the heading of the line of sight and the tilt from the vertical', () => {
    // Caméra au sud-ouest, 45° sous l'horizontale : visée nord-est, inclinaison 45°.
    const camera = offsetGeoPoint(target, [-1000 / Math.SQRT2, -1000 / Math.SQRT2, 1000]);
    const view = googleEarthViewFromCamera(camera, target, 35)!;
    expect(view.headingDeg).toBeCloseTo(45, 6);
    expect(view.tiltDeg).toBeCloseTo(45, 6);
    expect(view.distanceM).toBeCloseTo(1000 * Math.SQRT2, 3);
  });

  it('tilts past 90° when looking up, and keeps headings in [0, 360)', () => {
    const camera = offsetGeoPoint(target, [500, 0, -100]);
    const view = googleEarthViewFromCamera(camera, target, 35)!;
    expect(view.headingDeg).toBeCloseTo(270, 6);
    expect(view.tiltDeg).toBeCloseTo(90 + Math.atan(100 / 500) / DEG, 6);
  });

  it('takes the heading of a vertical sight from the top of the screen', () => {
    const camera = { ...target, altitudeM: 2035 };
    const ne: [number, number, number] = [Math.SQRT1_2, Math.SQRT1_2, 0];
    expect(googleEarthViewFromCamera(camera, target, 35, ne)!.headingDeg).toBeCloseTo(45, 9);
    // Vers le zénith, le haut de l'écran est à l'opposé du cap.
    const sky = googleEarthViewFromCamera(target, camera, 35, ne)!;
    expect(sky.headingDeg).toBeCloseTo(225, 9);
    expect(sky.tiltDeg).toBeCloseTo(180, 9);
  });

  it('refuses a camera on the target', () => {
    expect(googleEarthViewFromCamera(target, target, 35)).toBeNull();
  });
});

describe('buildGoogleEarthUrl', () => {
  it('writes the @lat,lon,a,d,y,h,t,r path Google Earth reads', () => {
    const url = buildGoogleEarthUrl({
      target: { lon: 4.16087777, lat: 45.19495908, altitudeM: 663.70095798 },
      distanceM: 86947.37079763,
      fovYDeg: 35,
      headingDeg: -355.33116737,
      tiltDeg: 38.69287436,
    });
    expect(url).toBe('https://earth.google.com/web/@45.19495908,4.16087777,663.701a,86947.371d,35.0000y,4.6688h,38.6929t,0r');
  });

  it('never writes a negative zero, a tilt out of [0, 180] or a null distance', () => {
    const url = buildGoogleEarthUrl({
      target: { lon: -0.000000001, lat: 0, altitudeM: -0.0001 },
      distanceM: 0,
      fovYDeg: 60,
      headingDeg: 360,
      tiltDeg: 181,
    });
    expect(url).toBe('https://earth.google.com/web/@0.00000000,0.00000000,0.000a,0.010d,60.0000y,0.0000h,180.0000t,0r');
  });
});

describe('isGoogleEarthShortcut', () => {
  const key = (init: KeyboardEventInit) => ({ repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;

  it('takes the letter M, whatever the layout (AZERTY M is not KeyM)', () => {
    expect(isGoogleEarthShortcut(key({ key: 'm', code: 'Semicolon' }))).toBe(true);
    expect(isGoogleEarthShortcut(key({ key: 'M', code: 'Semicolon', shiftKey: true }))).toBe(true);
    expect(isGoogleEarthShortcut(key({ key: ',', code: 'KeyM' }))).toBe(false);
  });

  it('ignores modifiers and auto-repeat', () => {
    expect(isGoogleEarthShortcut(key({ key: 'm', ctrlKey: true }))).toBe(false);
    expect(isGoogleEarthShortcut(key({ key: 'm', metaKey: true }))).toBe(false);
    expect(isGoogleEarthShortcut(key({ key: 'm', altKey: true }))).toBe(false);
    expect(isGoogleEarthShortcut(key({ key: 'm', repeat: true }))).toBe(false);
  });
});
