import { describe, expect, it } from 'vitest';

import type { PredictionResult } from '@/features/fitPredictor';

import { buildSeriesFromPrediction, locateRoutePointAtX } from './builders';
import { normalizeRouteProfile } from './routeProfile';

/** Prediction whose speed grows linearly with distance, at irregular spacing. */
function linearSpeedPrediction(km: number): PredictionResult {
  let s = 5;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const points = [];
  let distanceM = 0;
  let elapsedS = 0;
  while (distanceM < km * 1000) {
    const speed = 15 + distanceM / 1000; // km/h, +1 km/h per km
    points.push({
      distance_m: distanceM,
      elevation_m: 500,
      gradient_pct: 0,
      predicted_speed_kmh: speed,
      predicted_power_w: 200,
      elapsed_time_s: elapsedS,
      segment_time_s: 0,
    });
    const step = 3 + rnd() * 37;
    distanceM += step;
    elapsedS += step / (speed / 3.6);
  }
  return {
    total_time_s: elapsedS,
    riding_time_s: elapsedS,
    stop_time_s: 0,
    total_distance_m: distanceM,
    avg_speed_kmh: 20,
    elevation_gain_m: 0,
    elevation_loss_m: 0,
    segments: [],
    points,
  } as unknown as PredictionResult;
}

describe('interval average series', () => {
  it('averages the speed over each 500 m interval (linear speed → interval midpoint)', () => {
    const prediction = linearSpeedPrediction(40);
    const series = buildSeriesFromPrediction(prediction, 'Vitesse moyenne', 'distance');
    expect(series).not.toBeNull();
    // Steps: (start, y), (end, y) per interval; y = speed at the interval midpoint.
    let checked = 0;
    for (let i = 1; i < series!.length; i++) {
      const a = series![i - 1]!;
      const b = series![i]!;
      if (a.y !== b.y || b.x - a.x < 0.499) continue;
      expect(a.y).toBeCloseTo(15 + (a.x + b.x) / 2, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(70);
  });
});

describe('route-backed series cache', () => {
  it('serves a route with corrupted altitudes from the cache', () => {
    const routePoints = Array.from({ length: 5_000 }, (_, i) => ({
      lat: 45 + i * 0.0001,
      lon: 6,
      distanceM: i * 12,
      elevationM: i % 997 === 0 ? -9522 : 700 + 50 * Math.sin(i / 300),
    }));
    const first = buildSeriesFromPrediction(null, 'Altitude', 'distance', routePoints, 'gpx');
    expect(first).not.toBeNull();
    expect(Math.min(...first!.map((p) => p.y))).toBeGreaterThan(600); // spikes cleaned
    // The cleaned profile itself is cached under the route (it was rebuilt at
    // every chart recomputation, keyed by a fresh cleaned copy).
    expect(normalizeRouteProfile(routePoints)).toBe(normalizeRouteProfile(routePoints));
  });
});

describe('locateRoutePointAtX', () => {
  it('finds the route point under the cursor (distance axis)', () => {
    const routePoints = Array.from({ length: 1_001 }, (_, i) => ({ lat: 45 + i * 0.0001, lon: 6, distanceM: i * 10, elevationM: i }));
    const point = locateRoutePointAtX(routePoints, null, 'distance', 2.505);
    expect(point?.elevationM).toBeCloseTo(250.5, 6);
  });
});
