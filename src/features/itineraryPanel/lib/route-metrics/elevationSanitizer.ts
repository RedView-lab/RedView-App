/**
 * Système professionnel de sanitisation et fiabilisation altimétrique.
 * Protège contre les codes sentinelles GPS/barométriques (-32768, -9999...),
 * les valeurs physiques impossibles sur Terre (<-500m ou >9000m),
 * les décrochages brutaux (pics isolés / drops) et assure une interpolation
 * continue le long de la trace.
 */

/**
 * Altitude terrestre minimale physiquement plausible sur terre ferme (m).
 * La dépression de la Mer Morte se situe à -430 m. Une marge de sécurité à -500 m
 * couvre la totalité des surfaces émergées de la planète.
 */
export const MIN_VALID_TERRESTRIAL_ELEVATION_M = -500;

/**
 * Altitude terrestre maximale physiquement plausible (m).
 * L'Everest culmine à 8 848 m. Une marge de sécurité à 9 000 m
 * couvre l'ensemble des sommets mondiaux.
 */
export const MAX_VALID_TERRESTRIAL_ELEVATION_M = 9_000;

/**
 * Codes sentinelles fréquents dans les puces GPS, fichiers GPX/FIT corrompus
 * ou lors de perte de fix barométrique.
 */
const SENTINEL_VALUES = new Set([
  -32768,
  -32767,
  -9999,
  -9999.0,
  -999,
  -10000,
  9999,
  32767,
  32768,
]);

/**
 * Détermine si une valeur d'altitude brute est valide et physiquement plausible.
 */
export function isValidElevation(ele: unknown): ele is number {
  if (ele == null) return false;
  const num = typeof ele === 'number' ? ele : Number(ele);
  if (!Number.isFinite(num)) return false;
  if (SENTINEL_VALUES.has(num) || SENTINEL_VALUES.has(Math.round(num))) return false;
  return num >= MIN_VALID_TERRESTRIAL_ELEVATION_M && num <= MAX_VALID_TERRESTRIAL_ELEVATION_M;
}

/**
 * Nettoie une valeur d'altitude individuelle : retourne le nombre valide ou null.
 */
export function sanitizeRawElevation(ele: unknown): number | null {
  return isValidElevation(ele) ? (typeof ele === 'number' ? ele : Number(ele)) : null;
}

/**
 * Détecte si une liste de points contient des valeurs d'altitude corrompues
 * (hors bornes, sentinelles ou non finies).
 */
export function hasCorruptedElevations(
  points: Array<{ elevationM?: number | null }>,
): boolean {
  for (let i = 0; i < points.length; i++) {
    const ele = points[i]?.elevationM;
    if (ele != null && !isValidElevation(ele)) {
      return true;
    }
  }
  return false;
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type ElevationPointInput = {
  elevationM?: number | null;
  distanceM?: number | null;
};

export type RoutePointWithElevation = ElevationPointInput;

/**
 * Nettoie, dé-bruite et interpole une série de points de route :
 * 1. Invalide les sentinelles et valeurs hors limites terrestres [-500m ; 9000m].
 * 2. Filtre les pics isolés anormaux (décrochages brutaux où le point plonge ou grimpe
 *    anormalement par rapport aux points voisins et à la médiane locale).
 * 3. Interpole spatialement (selon distanceM) les points manquants ou corrompus.
 * 4. Préserve les traces 2D (si aucun point n'a d'altitude valide).
 */
export function cleanAndInterpolateElevations<T extends ElevationPointInput>(
  points: T[],
): T[] {
  if (!points || points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0]!;
    return [{
      ...p,
      elevationM: sanitizeRawElevation(p.elevationM),
    }];
  }

  // Étape 1 : Assainissement initial des valeurs individuelles
  const n = points.length;
  const rawElevations = new Array<number | null>(n);
  let validCount = 0;

  for (let i = 0; i < n; i++) {
    const ele = sanitizeRawElevation(points[i]!.elevationM);
    rawElevations[i] = ele;
    if (ele !== null) validCount++;
  }

  // Si aucun point n'a d'altitude valide, on retourne avec elevationM = null (trace 2D)
  if (validCount === 0) {
    return points.map((pt, i) => (pt.elevationM === rawElevations[i] ? pt : { ...pt, elevationM: null }));
  }

  // Étape 2 : Détection des pics / anomalies locales (Hampel / Spike Filter)
  // On ne filtre que si on a suffisamment de points de référence
  if (validCount >= 3) {
    const cleanedElevations = rawElevations.slice();

    for (let i = 0; i < n; i++) {
      const current = cleanedElevations[i];
      if (current === null) continue;

      // Chercher le point valide précédent et suivant
      let prevVal: number | null = null;
      let prevDist: number = 0;
      for (let p = i - 1; p >= 0; p--) {
        if (cleanedElevations[p] !== null) {
          prevVal = cleanedElevations[p];
          prevDist = Math.max(1, (points[i]!.distanceM ?? i) - (points[p]!.distanceM ?? p));
          break;
        }
      }

      let nextVal: number | null = null;
      let nextDist: number = 0;
      for (let f = i + 1; f < n; f++) {
        if (cleanedElevations[f] !== null) {
          nextVal = cleanedElevations[f];
          nextDist = Math.max(1, (points[f]!.distanceM ?? f) - (points[i]!.distanceM ?? i));
          break;
        }
      }

      // Cas 1 : Pic isolé en V ou V inversé (le point saute d'au moins 60m par rapport
      // à ses deux voisins immédiats, qui sont eux cohérents entre eux à < 40m)
      if (prevVal !== null && nextVal !== null) {
        const deltaPrev = current - prevVal;
        const deltaNext = current - nextVal;
        const neighborsDiff = Math.abs(prevVal - nextVal);

        const isSharpSpike =
          ((deltaPrev > 60 && deltaNext > 60) || (deltaPrev < -60 && deltaNext < -60)) &&
          neighborsDiff < 45;

        // Cas 2 : Gradient vertical physiquement impossible (> 250% de pente sur courte distance)
        const slopePrev = Math.abs(deltaPrev) / prevDist;
        const slopeNext = Math.abs(deltaNext) / nextDist;
        const isImpossibleCliffSpike =
          (slopePrev > 2.5 && slopeNext > 2.5) &&
          ((deltaPrev * deltaNext) > 0);

        if (isSharpSpike || isImpossibleCliffSpike) {
          cleanedElevations[i] = null;
          continue;
        }
      }

      // Cas 3 : Fenêtre locale glissante de 7 points valides
      const windowVals: number[] = [];
      for (let w = Math.max(0, i - 4); w <= Math.min(n - 1, i + 4); w++) {
        if (cleanedElevations[w] !== null) {
          windowVals.push(cleanedElevations[w]!);
        }
      }

      if (windowVals.length >= 5) {
        const localMedian = calculateMedian(windowVals);
        const absDiffFromMedian = Math.abs(current - localMedian);
        // Si le point s'écarte de plus de 100m de la médiane locale alors que
        // le relief local est modéré
        if (absDiffFromMedian > 100) {
          const mediansAbsDev = calculateMedian(windowVals.map((v) => Math.abs(v - localMedian)));
          if (absDiffFromMedian > Math.max(70, mediansAbsDev * 4)) {
            cleanedElevations[i] = null;
          }
        }
      }
    }

    // Réassigner après filtre anti-pics
    for (let i = 0; i < n; i++) {
      rawElevations[i] = cleanedElevations[i];
    }
  }

  // Étape 3 : Interpolation spatiale continue des valeurs manquantes ou supprimées
  const validIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rawElevations[i] !== null) validIndices.push(i);
  }

  if (validIndices.length === 0) {
    return points.map((pt) => ({ ...pt, elevationM: null }));
  }

  const firstValidIdx = validIndices[0]!;
  const lastValidIdx = validIndices[validIndices.length - 1]!;
  const firstVal = rawElevations[firstValidIdx]!;
  const lastVal = rawElevations[lastValidIdx]!;

  // Remplissage des segments de tête et de queue
  for (let i = 0; i < firstValidIdx; i++) {
    rawElevations[i] = firstVal;
  }
  for (let i = lastValidIdx + 1; i < n; i++) {
    rawElevations[i] = lastVal;
  }

  // Interpolation spatiale entre les indices valides consécutifs
  for (let k = 0; k < validIndices.length - 1; k++) {
    const idxA = validIndices[k]!;
    const idxB = validIndices[k + 1]!;
    if (idxB - idxA <= 1) continue;

    const valA = rawElevations[idxA]!;
    const valB = rawElevations[idxB]!;
    const distA = points[idxA]!.distanceM ?? idxA;
    const distB = points[idxB]!.distanceM ?? idxB;
    const totalDistSpan = distB - distA;

    for (let j = idxA + 1; j < idxB; j++) {
      let ratio: number;
      if (totalDistSpan > 0.01) {
        const curDist = points[j]!.distanceM ?? j;
        ratio = Math.max(0, Math.min(1, (curDist - distA) / totalDistSpan));
      } else {
        ratio = (j - idxA) / (idxB - idxA);
      }
      rawElevations[j] = Math.round((valA + (valB - valA) * ratio) * 10) / 10;
    }
  }

  // Assemblage du résultat
  return points.map((point, index) => {
    const ele = rawElevations[index];
    if (point.elevationM === ele) return point;
    return {
      ...point,
      elevationM: ele,
    };
  });
}
