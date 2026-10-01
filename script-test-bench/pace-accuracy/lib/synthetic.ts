/**
 * Tracés synthétiques pour les scénarios physiques du banc (S1–S24).
 * Coordonnées en mètres autour de 45° N 6° E, converties en lat/lon.
 */
import type { V2Route } from './engine';

const KY = 111_194.93;
const KX = KY * Math.cos((45 * Math.PI) / 180);

export interface XY { x: number; y: number; ele: number; surface?: number; way?: number }

export function routeFromXY(pts: XY[]): V2Route {
  return {
    lat: Float64Array.from(pts, (p) => 45 + p.y / KY),
    lon: Float64Array.from(pts, (p) => 6 + p.x / KX),
    ele: Float64Array.from(pts, (p) => p.ele),
    dist: new Float64Array(0),
    surface: Uint8Array.from(pts, (p) => p.surface ?? 1),
    way: Uint8Array.from(pts, (p) => p.way ?? 0),
    wind: new Float64Array(0),
  };
}

/** Ligne droite vers le nord, profil `eleAt(d)`, un point tous les `step` m. */
export function straight(lenM: number, eleAt: (d: number) => number, opts: { step?: number; surface?: number; way?: (d: number) => number } = {}): V2Route {
  const step = opts.step ?? 10;
  const pts: XY[] = [];
  for (let d = 0; d <= lenM + 1e-6; d += step) pts.push({ x: 0, y: d, ele: eleAt(d), surface: opts.surface, way: opts.way?.(d) });
  return routeFromXY(pts);
}

/** Lacets : `n` épingles de rayon `r` reliées par des droites de `leg` m, pente `grade` (fraction). */
export function hairpins(n: number, r: number, leg: number, grade: number, step = 2): V2Route {
  const pts: XY[] = [];
  let x = 0, y = 0, d = 0, dir = 1;
  const ele0 = 2000;
  const push = (px: number, py: number) => {
    if (pts.length > 0) d += Math.hypot(px - pts[pts.length - 1]!.x, py - pts[pts.length - 1]!.y);
    pts.push({ x: px, y: py, ele: ele0 + grade * d });
  };
  push(x, y);
  for (let k = 0; k < n; k++) {
    for (let s = step; s <= leg; s += step) push(x, y + dir * s);
    y += dir * leg;
    // Demi-tour de rayon r vers +x.
    const cx = x + r;
    const steps = Math.max(6, Math.ceil((Math.PI * r) / step));
    for (let i = 1; i <= steps; i++) {
      const a = Math.PI - (Math.PI * i) / steps;
      push(cx + r * Math.cos(a), y + dir * r * Math.sin(a));
    }
    x += 2 * r;
    dir = -dir;
  }
  for (let s = step; s <= leg; s += step) push(x, y + dir * s);
  return routeFromXY(pts);
}

/** Bruit pseudo-aléatoire reproductible dans [−0,5 ; 0,5[. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

export function withNoise(route: V2Route, horizM: number, vertM: number, seed = 7, correlated = true): V2Route {
  const r = rng(seed);
  let dx = 0, dy = 0;
  const lat = new Float64Array(route.lat.length);
  const lon = new Float64Array(route.lon.length);
  const ele = new Float64Array(route.ele.length);
  for (let i = 0; i < route.lat.length; i++) {
    if (correlated) {
      dx = 0.95 * dx + horizM * r();
      dy = 0.95 * dy + horizM * r();
    } else {
      dx = 2 * horizM * r();
      dy = 2 * horizM * r();
    }
    lat[i] = route.lat[i]! + dy / KY;
    lon[i] = route.lon[i]! + dx / KX;
    ele[i] = route.ele[i]! + 2 * vertM * r();
  }
  return { ...route, lat, lon, ele };
}

export function subsample(route: V2Route, every: number): V2Route {
  const keep = (_: unknown, i: number) => i % every === 0 || i === route.lat.length - 1;
  return {
    ...route,
    lat: route.lat.filter(keep),
    lon: route.lon.filter(keep),
    ele: route.ele.filter(keep),
    surface: route.surface.length ? route.surface.filter(keep) : route.surface,
    way: route.way.length ? route.way.filter(keep) : route.way,
  };
}

export function reversed(route: V2Route): V2Route {
  const rev = <T extends Float64Array | Uint8Array>(a: T): T => a.slice().reverse() as T;
  return { ...route, lat: rev(route.lat), lon: rev(route.lon), ele: rev(route.ele), surface: rev(route.surface), way: rev(route.way) };
}
