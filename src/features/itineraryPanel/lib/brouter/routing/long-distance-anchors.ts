/**
 * Très longs tracés : ancres intermédiaires.
 *
 * L'effort d'une recherche BRouter croît bien plus vite que la distance : sur
 * un tronçon de 800 km il faut une heuristique très gloutonne pour rester dans
 * le budget de temps, et le tracé y perd en qualité. On calcule donc d'abord
 * un tracé grossier (recherche rapide), on pose des ancres sur ce tracé environ
 * tous les `ANCHOR_SPACING_KM`, puis chaque tronçon court est recalculé
 * finement. Les ancres sont prises sur le tracé grossier (et non sur la ligne
 * droite, qui peut tomber dans un lac ou sur un sommet) : elles restent sur un
 * itinéraire plausible tout en laissant chaque tronçon explorer ses variantes.
 */
import type { BrouterPoint } from '../types';

/** Tronçon (vol d'oiseau, km) au-delà duquel on ancre. */
export const ANCHOR_SECTION_KM = 180;
/** Espacement visé des ancres le long du tracé grossier (km de tracé). */
export const ANCHOR_SPACING_KM = 160;

function haversineKm(a: BrouterPoint, b: BrouterPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function needsLongDistanceAnchors(points: BrouterPoint[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (haversineKm(points[i - 1]!, points[i]!) > ANCHOR_SECTION_KM) return true;
  }
  return false;
}

/**
 * Via de la requête affinée : via de l'utilisateur + ancres posées sur le
 * tracé grossier `coarse` ([lon, lat] de départ → arrivée), dans l'ordre.
 * `null` si le tracé grossier est inexploitable.
 */
export function buildAnchoredVia(points: BrouterPoint[], coarse: [number, number][]): BrouterPoint[] | null {
  if (points.length < 2 || coarse.length < 2) return null;
  const coords = coarse.map(([lon, lat]) => ({ lon, lat }));
  const cumKm = [0];
  for (let i = 1; i < coords.length; i += 1) cumKm.push(cumKm[i - 1]! + haversineKm(coords[i - 1]!, coords[i]!));

  // Position de chaque point utilisateur sur le tracé grossier (recherche vers l'avant).
  const indices = [0];
  for (let p = 1; p < points.length - 1; p += 1) {
    let best = indices[p - 1]!;
    let bestKm = Infinity;
    for (let i = indices[p - 1]!; i < coords.length; i += 1) {
      const d = haversineKm(points[p]!, coords[i]!);
      if (d < bestKm) {
        bestKm = d;
        best = i;
      }
    }
    // Via introuvable sur le tracé (> 5 km) : on renonce à ancrer.
    if (bestKm > 5) return null;
    indices.push(best);
  }
  indices.push(coords.length - 1);

  const via: BrouterPoint[] = [];
  for (let section = 0; section < points.length - 1; section += 1) {
    if (section > 0) via.push(points[section]!);
    if (haversineKm(points[section]!, points[section + 1]!) <= ANCHOR_SECTION_KM) continue;
    const fromKm = cumKm[indices[section]!]!;
    const lengthKm = cumKm[indices[section + 1]!]! - fromKm;
    const anchors = Math.ceil(lengthKm / ANCHOR_SPACING_KM) - 1;
    let i = indices[section]!;
    for (let a = 1; a <= anchors; a += 1) {
      const targetKm = fromKm + (lengthKm * a) / (anchors + 1);
      while (i < indices[section + 1]! && cumKm[i]! < targetKm) i += 1;
      via.push(coords[i]!);
    }
  }
  return via;
}
