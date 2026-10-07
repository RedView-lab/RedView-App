/**
 * Regroupement des bulles qui se chevauchent à l'écran (comme les « clusters »
 * de Figma) : glouton et déterministe, dans l'ordre des fils. Recalculé à la
 * fin d'un mouvement de carte ; pendant le mouvement, chaque marqueur suit sa
 * propre coordonnée.
 */

export interface ScreenPin {
  id: string;
  x: number;
  y: number;
}

export interface PinCluster {
  /** Fils du groupe, dans l'ordre d'entrée (le premier sert d'ancre). */
  ids: string[];
  x: number;
  y: number;
}

/** Écart (px) en dessous duquel deux bulles se regroupent. */
const CLUSTER_RADIUS_PX = 28;

export function clusterPins(pins: readonly ScreenPin[], radiusPx = CLUSTER_RADIUS_PX): PinCluster[] {
  const radiusSq = radiusPx * radiusPx;
  const assigned = new Set<string>();
  const clusters: PinCluster[] = [];
  for (const seed of pins) {
    if (assigned.has(seed.id) || !Number.isFinite(seed.x) || !Number.isFinite(seed.y)) continue;
    assigned.add(seed.id);
    const cluster: PinCluster = { ids: [seed.id], x: seed.x, y: seed.y };
    for (const other of pins) {
      if (assigned.has(other.id) || !Number.isFinite(other.x) || !Number.isFinite(other.y)) continue;
      const dx = other.x - seed.x;
      const dy = other.y - seed.y;
      if (dx * dx + dy * dy <= radiusSq) {
        assigned.add(other.id);
        cluster.ids.push(other.id);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/** Signature d'un regroupement (même signature : rien à reconstruire). */
export function clusterSignature(clusters: readonly PinCluster[]): string {
  return clusters.filter((cluster) => cluster.ids.length > 1).map((cluster) => cluster.ids.join(',')).join('|');
}
