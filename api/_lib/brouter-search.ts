/**
 * Coefficient de la recherche A* de BRouter côté proxy (`pass1coefficient`,
 * passe unique `pass2coefficient = -1`).
 *
 * Le client l'envoie, calculé selon la distance et l'échelle de coût de son
 * profil (src/features/itineraryPanel/lib/brouter/api/searchCoefficient.ts —
 * garder les paliers en phase). Le proxy le borne : jamais sous le plancher de
 * la distance (un coefficient trop bas sur 1 000 km monopoliserait un thread
 * BRouter), et le calcule lui-même quand il manque.
 */

/** Échelle de coût des profils stock BRouter (trekking, fastbike…). */
const DEFAULT_COST_SCALE = 1.4;
const MAX_COEFFICIENT = 12;
/** Plancher absolu du coefficient, en fraction du poids de la distance. */
const FLOOR_FRACTION = 0.9;

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

function weightForKm(km: number): number {
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

function parseLonlats(lonlats: string): Array<{ lon: number; lat: number }> {
  return lonlats
    .split('|')
    .map((pair) => pair.split(',').map(Number))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    .map(([lon, lat]) => ({ lon: lon!, lat: lat! }));
}

/** √(Σ Lᵢ²) des tronçons à vol d'oiseau (km) — voir searchCoefficient.ts. */
export function effectiveSearchKm(lonlats: string): number {
  const points = parseLonlats(lonlats);
  const toRad = Math.PI / 180;
  let sumSq = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dLat = (b.lat - a.lat) * toRad;
    const dLon = (b.lon - a.lon) * toRad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
    sumSq += (12_742 * Math.asin(Math.min(1, Math.sqrt(s)))) ** 2;
  }
  return Math.sqrt(sumSq);
}

/** Coefficient à transmettre à BRouter pour cette requête. */
export function resolvePass1Coefficient(lonlats: string, requested: string | null): number {
  const weight = weightForKm(effectiveSearchKm(lonlats));
  const floor = weight * FLOOR_FRACTION;
  const asked = requested == null ? Number.NaN : Number(requested);
  const value = Number.isFinite(asked) ? asked : DEFAULT_COST_SCALE * weight;
  return Math.round(Math.min(MAX_COEFFICIENT, Math.max(floor, value)) * 100) / 100;
}
