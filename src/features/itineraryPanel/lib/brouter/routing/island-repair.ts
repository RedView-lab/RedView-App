/**
 * Points accrochés à un « îlot » du graphe BRouter.
 *
 * BRouter accroche chaque point à la voie la plus proche, même quand cette
 * voie n'est reliée au reste du réseau que par des voies interdites (zone
 * piétonne fermée, parking privé, quai…). Le calcul échoue alors en entier :
 *   - « target island detected for section N » : le point N+1 est sur un îlot ;
 *   - « no track found at pass=0 » : en pratique, le départ est sur un îlot
 *     (BRouter ne détecte l'îlot que côté arrivée).
 * Décaler le point de quelques centaines de mètres vers son voisin suffit à
 * retomber sur le réseau : on propose ces décalages, du plus petit au plus grand.
 */
import type { BrouterPoint } from '../types';

export function isBrouterIslandError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /no track found|island detected/i.test(error.message);
}

export interface IslandRepairCandidate {
  points: BrouterPoint[];
  /** Index du point déplacé dans `points`. */
  movedIndex: number;
  movedM: number;
}

function distanceM(a: BrouterPoint, b: BrouterPoint): number {
  const kx = 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110_540);
}

/** Déplace `p` de `meters` vers `toward` (ou à angle droit si `perpendicular`). */
function nudge(p: BrouterPoint, toward: BrouterPoint, meters: number, perpendicular = false): BrouterPoint {
  const kx = 111_320 * Math.cos(p.lat * (Math.PI / 180));
  let dx = (toward.lon - p.lon) * kx;
  let dy = (toward.lat - p.lat) * 110_540;
  const len = Math.hypot(dx, dy);
  if (len < 1) return p;
  if (perpendicular) [dx, dy] = [-dy, dx];
  const step = Math.min(meters, len / 3);
  return { lat: p.lat + ((dy / len) * step) / 110_540, lon: p.lon + ((dx / len) * step) / kx };
}

/** Index du point en cause d'après le message d'erreur BRouter (null : inconnu). */
export function islandPointIndex(error: unknown, pointCount: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const section = /island detected for section (\d+)/i.exec(message);
  if (section) {
    const index = Number(section[1]) + 1;
    return index < pointCount ? index : null;
  }
  return /no track found/i.test(message) ? 0 : null;
}

/**
 * Décalages à essayer (dans l'ordre) pour sortir le point fautif de l'îlot.
 * Point inconnu : on tente le départ puis l'arrivée.
 */
export function buildIslandRepairCandidates(points: BrouterPoint[], error: unknown): IslandRepairCandidate[] {
  if (points.length < 2) return [];
  const known = islandPointIndex(error, points.length);
  const indices = known != null && known > 0 ? [known] : [0, points.length - 1];
  const out: IslandRepairCandidate[] = [];
  for (const index of indices) {
    const neighbour = points[index === points.length - 1 ? index - 1 : index + 1]!;
    const shifts: Array<[number, boolean]> = index === indices[0]
      ? [[200, false], [500, false], [300, true]]
      : [[200, false], [500, false]];
    for (const [meters, perpendicular] of shifts) {
      const moved = nudge(points[index]!, neighbour, meters, perpendicular);
      const next = points.slice();
      next[index] = moved;
      out.push({ points: next, movedIndex: index, movedM: Math.round(distanceM(points[index]!, moved)) });
    }
  }
  return out;
}
