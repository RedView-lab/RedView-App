/**
 * Coefficient de la recherche A* de BRouter (`pass1coefficient`, passe unique
 * `pass2coefficient = -1`).
 *
 * L'heuristique vaut `coefficient × distance à vol d'oiseau restante`. Rapportée
 * au coût réel au mètre du profil, elle fixe le compromis : proche de 1 la
 * recherche est quasi exacte mais explore une grande zone (lent sur les longs
 * tracés) ; au-delà elle file droit vers l'arrivée et rate les meilleurs
 * itinéraires. Le coefficient est donc `échelle de coût du profil × poids`,
 * le poids croissant avec la distance (budget de latence « équilibré »,
 * calibré par script-test-bench/routing-quality/sweep.ts).
 *
 * Garder en phase avec api/_lib/brouter-search.ts (repli côté proxy).
 */
import type { BrouterPoint } from '../types';

/** Échelle de coût des profils stock BRouter (trekking, fastbike…). */
export const DEFAULT_SEARCH_COST_SCALE = 1.4;
const MIN_COEFFICIENT = 0.75;
const MAX_COEFFICIENT = 12;

function haversineKm(a: BrouterPoint, b: BrouterPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Somme des distances à vol d'oiseau des tronçons (km). */
export function requestBeelineKm(points: BrouterPoint[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i += 1) km += haversineKm(points[i - 1]!, points[i]!);
  return km;
}

/**
 * Distance « d'effort » : BRouter route chaque tronçon séparément et l'effort
 * d'une recherche croît plus vite que sa longueur. √(Σ Lᵢ²) vaut la longueur
 * d'un tracé sans via et reste modérée pour un long tracé découpé en étapes.
 */
export function effectiveSearchKm(points: BrouterPoint[]): number {
  let sumSq = 0;
  for (let i = 1; i < points.length; i += 1) sumSq += haversineKm(points[i - 1]!, points[i]!) ** 2;
  return Math.sqrt(sumSq);
}

/**
 * Poids de l'heuristique selon la distance d'effort (paliers interpolés),
 * relatif au coût réel au mètre du profil. Sweep d'octobre 2026 (62 tracés,
 * 7 profils) : poids 0,8 → écart médian au tracé optimal ~0 % en ~1 s sous
 * 100 km ; 1,2–1,3 → ~2 % sur 100–200 km, mais 1 s au lieu de 5 s au départ
 * d'un réseau dense (Paris) ; l'ancien 3,5 fixe valait un poids de 1,1 (VTT)
 * à 2,5 (route), soit des tracés 15 à 40 % plus coûteux.
 */
const WEIGHT_STEPS: ReadonlyArray<readonly [km: number, weight: number]> = [
  [0, 0.8],
  [50, 0.85],
  [100, 1.1],
  [150, 1.25],
  [225, 1.3],
  [370, 1.4],
  [600, 1.6],
  [1000, 2.0],
];

export function searchWeightForKm(km: number): number {
  if (km <= WEIGHT_STEPS[0]![0]) return WEIGHT_STEPS[0]![1];
  for (let i = 1; i < WEIGHT_STEPS.length; i += 1) {
    const [k1, w1] = WEIGHT_STEPS[i]!;
    if (km <= k1) {
      const [k0, w0] = WEIGHT_STEPS[i - 1]!;
      return w0 + ((w1 - w0) * (km - k0)) / (k1 - k0);
    }
  }
  return WEIGHT_STEPS[WEIGHT_STEPS.length - 1]![1];
}

/**
 * Échelle observée par profil : coût BRouter / longueur des tracés déjà
 * calculés (moyenne glissante). Plus fiable que l'estimation a priori dès le
 * deuxième calcul, et l'utilisateur recalcule sans cesse le même profil en
 * déplaçant ses points.
 */
const observedScales = new Map<string, number>();
const MAX_OBSERVED_PROFILES = 64;

export function recordObservedCostScale(profile: string | undefined, cost: number, distanceM: number): void {
  if (!profile || !(cost > 0) || !(distanceM > 2_000)) return;
  const sample = cost / distanceM;
  if (!Number.isFinite(sample) || sample < 0.3 || sample > 50) return;
  const previous = observedScales.get(profile);
  observedScales.delete(profile);
  observedScales.set(profile, previous == null ? sample : previous * 0.6 + sample * 0.4);
  if (observedScales.size > MAX_OBSERVED_PROFILES) {
    const oldest = observedScales.keys().next().value;
    if (oldest !== undefined) observedScales.delete(oldest);
  }
}

export function observedCostScale(profile: string | undefined): number | undefined {
  const scale = profile ? observedScales.get(profile) : undefined;
  // Arrondi au dixième : le coefficient (donc l'URL et le tracé) ne bouge pas à chaque calcul.
  return scale == null ? undefined : Math.round(scale * 10) / 10;
}

/** Poids d'un tracé grossier (repérage des ancres des très longs tracés). */
export const COARSE_SEARCH_WEIGHT = 2.4;

export function resolveSearchCoefficient(
  points: BrouterPoint[],
  costScale = DEFAULT_SEARCH_COST_SCALE,
  weight?: number,
): number {
  const scale = Number.isFinite(costScale) && costScale > 0 ? costScale : DEFAULT_SEARCH_COST_SCALE;
  const w = weight != null && Number.isFinite(weight) && weight > 0 ? weight : searchWeightForKm(effectiveSearchKm(points));
  const coefficient = scale * w;
  return Math.round(Math.min(MAX_COEFFICIENT, Math.max(MIN_COEFFICIENT, coefficient)) * 100) / 100;
}
