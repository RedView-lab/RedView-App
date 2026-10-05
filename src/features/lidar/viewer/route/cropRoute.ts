import type { LidarRouteOverlayPoint } from './types';

/** Écart au sol sous lequel un départ / une arrivée posé(e) l'est sur le tracé. */
const ON_ROUTE_PLACEMENT_TOLERANCE_M = 15;

/** Distance équirectangulaire entre deux points du tracé (m). */
function groundDistanceM(a: LidarRouteOverlayPoint, b: LidarRouteOverlayPoint): number {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  return Math.hypot((b.lon - a.lon) * Math.cos(meanLat), b.lat - a.lat) * 111_320;
}

/**
 * « Démarrer ici » / « Finir ici » posé sur le tracé : rognage exact au point,
 * comme dans l'app (`keep: 'after'` garde la suite, `'before'` le début).
 * Remplacer le premier / dernier point par le clic le reliait au reste du
 * tracé par une ligne droite. `null` quand le point n'est pas sur le tracé.
 */
export function cropRouteAt(
  points: LidarRouteOverlayPoint[],
  at: LidarRouteOverlayPoint,
  keep: 'before' | 'after',
): LidarRouteOverlayPoint[] | null {
  if (points.length < 2) return null;
  let best = { index: -1, t: 0, distM: Number.POSITIVE_INFINITY };
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const cos = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    const dx = (b.lon - a.lon) * cos;
    const dy = b.lat - a.lat;
    const px = (at.lon - a.lon) * cos;
    const py = at.lat - a.lat;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSq)) : 0;
    const distM = Math.hypot(px - t * dx, py - t * dy) * 111_320;
    if (distM < best.distM) best = { index: k, t, distM };
  }
  if (best.distM > ON_ROUTE_PLACEMENT_TOLERANCE_M) return null;
  const a = points[best.index]!;
  const b = points[best.index + 1]!;
  const elevationM = Number.isFinite(a.elevationM) && Number.isFinite(b.elevationM)
    ? (a.elevationM as number) + ((b.elevationM as number) - (a.elevationM as number)) * best.t
    : at.elevationM ?? a.elevationM ?? null;
  const cut: LidarRouteOverlayPoint = {
    lat: a.lat + (b.lat - a.lat) * best.t,
    lon: a.lon + (b.lon - a.lon) * best.t,
    elevationM,
  };
  const kept = keep === 'after'
    ? [cut, ...points.slice(best.t >= 1 ? best.index + 2 : best.index + 1)]
    : [...points.slice(0, best.t <= 0 ? best.index : best.index + 1), cut];
  if (kept.length < 2) return null;
  let distanceM = 0;
  return kept.map((point, index) => {
    if (index > 0) distanceM += groundDistanceM(kept[index - 1]!, point);
    return { ...point, distanceM };
  });
}
