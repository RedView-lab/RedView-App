import { resolveDem3dSelection } from './dem3dSelection';

/**
 * 3D DEM quality bus.
 *
 * Decouples the ControlPanel "Qualité 3D" selector from the map3d
 * lifecycle controller. The control panel writes the active quality
 * here; the map hook subscribes and swaps the bound terrain source
 * accordingly.
 *
 * Two qualities are supported:
 *   - 'hd'      : unified-dem (Service-Worker pipeline: IGN MNS LiDAR
 *                 0.40 m over France/Swiss + Mapbox Terrain-RGB elsewhere).
 *                 This is the historical "slow-040" option.
 *   - 'fast-30m': aws-fast-dem (AWS Open Data Terrarium, ~30 m, decoded
 *                 natively on the GPU). No Service Worker, no IGN. Perfect
 *                 for instant flyovers and weaker connections.
 */

export type Dem3dQuality = 'hd' | 'fast-30m';

export const DEFAULT_DEM3D_QUALITY: Dem3dQuality = 'fast-30m';

const VALID_QUALITIES: ReadonlySet<string> = new Set(['hd', 'fast-30m']);

/**
 * Normalize legacy / persisted option ids to the canonical `Dem3dQuality`
 * value. The ControlPanel stores values like 'slow-040' (HD surface),
 * 'terrain-1m' (HD terrain), or 'fast-30m'.
 */
export function normalizeDem3dQuality(value: string | null | undefined): Dem3dQuality {
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
