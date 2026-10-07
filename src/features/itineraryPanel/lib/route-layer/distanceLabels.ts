import { haversineRouteDistanceM } from '../routes/route-distance';

/**
 * Bornes kilométriques posées sur la trace quand le filtre « Pente » est actif :
 * mêmes distances que l'axe du graphe central (`distanceM` du point quand il
 * est cohérent, sinon cumul haversine — règle de `getRoutePointDistances`).
 */

export interface DistanceLabelRoutePoint {
  lat: number;
  lon: number;
  distanceM?: number;
}

export interface RouteDistanceLabel {
  km: number;
  lngLat: [number, number];
  /** 0 = borne la plus importante ; gagne quand deux bornes se chevauchent à l'écran. */
  rank: number;
}

/** Jusqu'à cette longueur la trace est bornée tous les 25 km, au-delà tous les 50 km. */
const DISTANCE_LABEL_SHORT_ROUTE_MAX_KM = 300;
/** Une borne trop proche de l'arrivée cacherait son drapeau. */
const END_CLEARANCE_RATIO = 0.3;

export function resolveDistanceLabelStepKm(totalKm: number): number {
  return totalKm <= DISTANCE_LABEL_SHORT_ROUTE_MAX_KM ? 25 : 50;
}

function cumulativeDistancesM(points: readonly DistanceLabelRoutePoint[]): number[] {
  const out: number[] = [0];
  let cumulative = 0;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    const next = point.distanceM;
    if (next != null && Number.isFinite(next) && next >= cumulative) {
      cumulative = next;
    } else {
      cumulative += haversineRouteDistanceM(points[index - 1]!, point);
    }
    out.push(cumulative);
  }
  return out;
}

export function buildRouteDistanceLabels(points: readonly DistanceLabelRoutePoint[]): RouteDistanceLabel[] {
  if (points.length < 2) return [];
  const distances = cumulativeDistancesM(points);
  const totalM = distances[distances.length - 1]!;
  const stepKm = resolveDistanceLabelStepKm(totalM / 1000);
  const stepM = stepKm * 1000;
  const lastTargetM = totalM - stepM * END_CLEARANCE_RATIO;

  const labels: RouteDistanceLabel[] = [];
  let segment = 1;
  for (let km = stepKm; km * 1000 <= lastTargetM; km += stepKm) {
    const targetM = km * 1000;
    while (segment < distances.length - 1 && distances[segment]! < targetM) segment += 1;
    const a = points[segment - 1]!;
    const b = points[segment]!;
    const startM = distances[segment - 1]!;
    const span = distances[segment]! - startM;
    const t = span > 0 ? Math.min(1, Math.max(0, (targetM - startM) / span)) : 0;
    labels.push({
      km,
      lngLat: [a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t],
      rank: km % (stepKm * 4) === 0 ? 0 : km % (stepKm * 2) === 0 ? 1 : 2,
    });
  }
  return labels;
}

export interface ScreenLabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
  km: number;
}

export interface ScreenObstacleBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesOverlap(a: ScreenObstacleBox, b: ScreenObstacleBox, gapPx: number): boolean {
  return Math.abs(a.x - b.x) * 2 < a.width + b.width + gapPx * 2
    && Math.abs(a.y - b.y) * 2 < a.height + b.height + gapPx * 2;
}

/** Décalage d'une pastille par rapport à son point de la trace (px de layout). */
export type LabelOffset = readonly [number, number];

/**
 * Positions essayées pour une pastille : centrée sur la trace, puis au-dessus,
 * en dessous, à droite, à gauche (placement variable, comme les libellés Mapbox).
 */
function candidateOffsets(box: ScreenLabelBox, gapPx: number): LabelOffset[] {
  const dy = box.height + gapPx;
  const dx = box.width + gapPx;
  return [[0, 0], [0, -dy], [0, dy], [dx, 0], [-dx, 0]];
}

/**
 * Placement des bornes à ce zoom : les plus importantes d'abord (multiples de
 * 4 pas, puis 2 pas). Chaque borne prend la première position libre — sa
 * pastille ne touche (à `gapPx` près) aucune pastille déjà placée ni aucun
 * marqueur de la trace (`obstacles` : départ, arrivée, pauses, alertes, qui
 * gardent la priorité) — ou reste masquée. Boîtes centrées, en px de layout de
 * la carte. Renvoie le décalage de chaque borne affichée, par indice.
 */
export function placeLabelBoxes(
  boxes: readonly ScreenLabelBox[],
  gapPx: number,
  obstacles: readonly ScreenObstacleBox[] = [],
): Map<number, LabelOffset> {
  const order = boxes
    .map((box, index) => ({ box, index }))
    .sort((a, b) => a.box.rank - b.box.rank || a.box.km - b.box.km);
  const kept: ScreenObstacleBox[] = [];
  const placed = new Map<number, LabelOffset>();
  for (const { box, index } of order) {
    if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) continue;
    for (const offset of candidateOffsets(box, gapPx)) {
      const moved = { ...box, x: box.x + offset[0], y: box.y + offset[1] };
      if (obstacles.some((obstacle) => boxesOverlap(moved, obstacle, gapPx / 2))) continue;
      if (kept.some((other) => boxesOverlap(moved, other, gapPx))) continue;
      kept.push(moved);
      placed.set(index, offset);
      break;
    }
  }
  return placed;
}
