import { describe, expect, it } from 'vitest';

import {
  APP_SCALE_DESIGN_HEIGHT,
  APP_SCALE_DESIGN_WIDTH,
  APP_SCALE_HIDPI_MIN,
  APP_SCALE_MAX,
  appScaleStyle,
  computeAppScale,
} from './appScale';

describe('computeAppScale', () => {
  it('is 1:1 at the 1920×1080 design reference', () => {
    expect(computeAppScale({ w: APP_SCALE_DESIGN_WIDTH, h: APP_SCALE_DESIGN_HEIGHT })).toBe(1);
  });

  it.each([
    ['half-screen 1080p', 960, 1040],
    ['1366×768 laptop', 1366, 768],
    ['1080p laptop at 150 %', 1280, 720],
    ['window too small', 820, 500],
  ])('never shrinks below 1:1 on a standard-density screen (%s)', (_label, w, h) => {
    expect(computeAppScale({ w, h, hiDpi: false })).toBe(1);
    expect(computeAppScale({ w, h })).toBe(1);
  });

  // Fenêtre du navigateur dans l'écran (barre de menus et onglets retirés).
  it.each([
    ['MacBook Air 13" ≈ 0.87', 1440, 790, 0.866],
    ['MacBook Pro 14" ≈ 0.89', 1512, 860, 0.894],
  ])('on Retina, takes half the deficit below the reference (%s)', (_label, w, h, expected) => {
    expect(computeAppScale({ w, h, hiDpi: true })).toBe(expected);
  });

  it('never goes under the Retina floor', () => {
    expect(computeAppScale({ w: 900, h: 500, hiDpi: true })).toBe(APP_SCALE_HIDPI_MIN);
  });

  it('grows gently above the reference, up to the cap', () => {
    expect(computeAppScale({ w: 2560, h: 1440 })).toBe(1.12);
    expect(computeAppScale({ w: 2133, h: 1200 })).toBeCloseTo(1.061, 3);
    expect(computeAppScale({ w: 3840, h: 2160, hiDpi: true })).toBe(APP_SCALE_MAX);
  });

  it('follows the limiting axis (ultrawide width goes to the map)', () => {
    expect(computeAppScale({ w: 3440, h: 1080 })).toBe(1);
    expect(computeAppScale({ w: 1920, h: 2000 })).toBe(1);
  });

  it('returns 1 for a degenerate viewport', () => {
    expect(computeAppScale({ w: Number.NaN, h: 1080 })).toBe(1);
  });
});

describe('appScaleStyle', () => {
  it('adds no style at 1:1', () => {
    expect(appScaleStyle(1)).toEqual({});
  });
});
