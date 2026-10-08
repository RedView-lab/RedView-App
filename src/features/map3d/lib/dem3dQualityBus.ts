import { resolveDem3dSelection } from './dem3dSelection';

/**
 * Bus de qualité du DEM 3D.
 *
 * Découple le sélecteur « Qualité 3D » du panneau de contrôle du contrôleur de
 * cycle de vie de map3d. Le panneau de contrôle écrit ici la qualité active ; le
 * hook de la carte s'y abonne et change en conséquence la source de terrain liée.
 *
 * Deux qualités sont gérées :
 *   - 'hd'      : unified-dem (pipeline du Service Worker : MNS LiDAR IGN à
 *                 0,40 m sur la France et la Suisse + Terrain-RGB Mapbox ailleurs).
 *                 C'est l'option historique « slow-040 ».
 *   - 'fast-30m': aws-fast-dem (AWS Open Data Terrarium, ~30 m, décodé
 *                 nativement sur le GPU). Sans Service Worker ni IGN. Idéal pour
 *                 des survols instantanés et les connexions plus faibles.
 */

export type Dem3dQuality = 'hd' | 'fast-30m';

const DEFAULT_DEM3D_QUALITY: Dem3dQuality = 'fast-30m';

const VALID_QUALITIES: ReadonlySet<string> = new Set(['hd', 'fast-30m']);

/**
 * Ramène les identifiants d'option anciens / persistés à la valeur canonique
 * `Dem3dQuality`. Le panneau de contrôle stocke des valeurs comme 'slow-040'
 * (surface HD), 'terrain-1m' (terrain HD) ou 'fast-30m'.
 */
function normalizeDem3dQuality(value: string | null | undefined): Dem3dQuality {
  return resolveDem3dSelection(value).quality;
}

let current: Dem3dQuality = DEFAULT_DEM3D_QUALITY;
const listeners = new Set<(q: Dem3dQuality) => void>();

export function getActiveDem3dQuality(): Dem3dQuality {
  return current;
}

export function setActiveDem3dQuality(next: Dem3dQuality | string | null | undefined): void {
  const normalized = typeof next === 'string' && VALID_QUALITIES.has(next)
    ? (next as Dem3dQuality)
    : normalizeDem3dQuality(typeof next === 'string' ? next : null);
  if (normalized === current) return;
  current = normalized;
  for (const listener of listeners) {
    try { listener(normalized); } catch (err) { console.warn('[dem3dQualityBus] listener failed', err); }
  }
}

export function subscribeDem3dQuality(listener: (q: Dem3dQuality) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
