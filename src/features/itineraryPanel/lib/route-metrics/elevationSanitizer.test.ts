import { describe, expect, it } from 'vitest';
import { cleanAndInterpolateElevations, hasCorruptedElevations, isValidElevation } from './elevationSanitizer';

type Point = { lat: number; lon: number; distanceM?: number; elevationM: number | null };

/** Seeded track: relief, GPS noise, holes, sentinels, spikes, cliffs, a long gap. */
function messyTrack(count: number, seed: number, withDistance = true): Point[] {
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, (_, i) => {
    let elevationM: number | null = 800 + 600 * Math.sin(i / 700) + 90 * Math.sin(i / 37) + rand() * 4;
    const u = rand();
    if (u < 0.05) elevationM = null;
    else if (u < 0.06) elevationM = -32768;
    else if (u < 0.065) elevationM += 400 * (rand() < 0.5 ? 1 : -1);
    else if (u < 0.07) elevationM += 140;
    if (i > count * 0.4 && i < count * 0.42) elevationM = null;
    const point: Point = { lat: 45 + i * 1e-4, lon: 6, elevationM };
    if (withDistance) point.distanceM = i * 12 + (i % 7 === 0 ? 0 : 3);
    return point;
  });
}

function fingerprint(points: Array<{ elevationM?: number | null }>): string {
  let hash = 0x811c9dc5;
  const bytes = new Uint8Array(Float64Array.from(points, (p) => p.elevationM ?? Number.NaN).buffer);
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${points.length}:${(hash >>> 0).toString(16)}`;
}

describe('cleanAndInterpolateElevations', () => {
  it('cleans a messy track exactly as before the window-median rewrite', () => {
    expect(fingerprint(cleanAndInterpolateElevations(messyTrack(20_000, 3)))).toBe('20000:bfc8cad');
    expect(fingerprint(cleanAndInterpolateElevations(messyTrack(5_000, 8, false)))).toBe('5000:7ca14055');
  });

  it('leaves only valid, finite altitudes', () => {
    const cleaned = cleanAndInterpolateElevations(messyTrack(5_000, 11));
    expect(hasCorruptedElevations(cleaned)).toBe(false);
    expect(cleaned.every((p) => isValidElevation(p.elevationM))).toBe(true);
  });

  it('removes an isolated spike and interpolates it along the distance', () => {
    const points: Point[] = [1000, 1002, 1004, 1006, 1400, 1010, 1012, 1014, 1016].map((elevationM, i) => ({
      lat: 45, lon: 6, distanceM: i * 10, elevationM,
    }));
    const cleaned = cleanAndInterpolateElevations(points);
    expect(cleaned[4]!.elevationM).toBe(1008);
    expect(cleaned[3]).toBe(points[3]); // untouched points keep their identity
  });

  it('keeps a 2D track 2D', () => {
    const points: Point[] = [null, -9999, null].map((elevationM) => ({ lat: 45, lon: 6, elevationM }));
    expect(cleanAndInterpolateElevations(points).map((p) => p.elevationM)).toEqual([null, null, null]);
  });
});
