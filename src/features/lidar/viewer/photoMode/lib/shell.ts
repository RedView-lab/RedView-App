// ============================================
// Ray / spherical shell intersections (cloud layer, atmosphere)
// ============================================
//
// The cloud layer is the space between two spheres around the Earth's
// centre, so it bends down to the horizon as a real one does. Positions are
// given as a horizontal offset (x, z) from the scene centre and an altitude
// above sea level; f32 keeps metres at 6 371 km only through the
// cancellation-free forms below (`c` from the altitude difference, roots
// from the stable quadratic). The cloud shader uses the same functions.

export const EARTH_RADIUS_M = 6_371_000;

/**
 * Distances along the ray to a sphere of altitude `shellAltM` (two roots,
 * ascending), or null when the ray misses it.
 * @param x horizontal offset (m) east of the scene centre
 * @param altM altitude of the origin above sea level (m)
 * @param z horizontal offset (m) south of the scene centre
 * @param dir unit direction (render frame)
 */
export function raySphere(
  x: number,
  altM: number,
  z: number,
  dir: readonly [number, number, number],
  shellAltM: number,
): [number, number] | null {
  const R = EARTH_RADIUS_M;
  const b = x * dir[0] + (R + altM) * dir[1] + z * dir[2];
  const c = x * x + z * z + (altM - shellAltM) * (2 * R + altM + shellAltM);
  const disc = b * b - c;
  if (disc < 0) return null;
  const q = -b - Math.sign(b || 1) * Math.sqrt(disc);
  if (q === 0) return [0, 0];
  const t0 = q;
  const t1 = c / q;
  return t0 < t1 ? [t0, t1] : [t1, t0];
}

/** Altitude (m) of a point at horizontal offset (x, z) and altitude-coordinate `altM` measured along the scene's vertical. */
export function shellAltitude(x: number, altM: number, z: number): number {
  const R = EARTH_RADIUS_M;
  // |o| − R without forming |o|² ≈ 4e13: (x² + z²) / (|o| + R + altM) + altM.
  const rCentre = R + altM;
  return altM + (x * x + z * z) / (Math.sqrt(x * x + z * z + rCentre * rCentre) + rCentre);
}

/**
 * The first stretch of the ray inside the layer between `baseM` and `topM`
 * (altitudes above sea level), within `maxDistM` and before the ground
 * sphere at `groundM`; null when it never enters.
 */
export function cloudLayerSegment(
  x: number,
  altM: number,
  z: number,
  dir: readonly [number, number, number],
  baseM: number,
  topM: number,
  maxDistM: number,
  groundM = -Infinity,
): [number, number] | null {
  if (Number.isFinite(groundM)) {
    const ground = raySphere(x, altM, z, dir, groundM);
    if (ground && ground[0] > 0) maxDistM = Math.min(maxDistM, ground[0]);
  }
  const alt = shellAltitude(x, altM, z);
  const top = raySphere(x, altM, z, dir, topM);
  if (!top || top[1] <= 0) return null;
  const base = raySphere(x, altM, z, dir, baseM);
  let start: number;
  let end: number;
  if (alt > topM) {
    // Above: enter through the top, leave through the base (or the top again when grazing).
    start = top[0];
    end = base && base[0] > 0 ? base[0] : top[1];
  } else if (alt >= baseM) {
    // Inside: until the top, or the base when looking down at it.
    start = 0;
    end = base && base[0] > 0 ? base[0] : top[1];
  } else {
    // Below: from where the ray leaves the inner sphere to the top.
    if (!base) return null;
    start = Math.max(0, base[1]);
    end = top[1];
  }
  start = Math.max(0, start);
  end = Math.min(end, maxDistM);
  return end > start ? [start, end] : null;
}
