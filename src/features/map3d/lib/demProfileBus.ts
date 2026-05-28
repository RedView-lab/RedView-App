import type { DemTileProfile } from '../hooks/useMap/demTiles';

let current: DemTileProfile = 'default';
const listeners = new Set<(profile: DemTileProfile) => void>();

export function getActiveDemProfilePreference(): DemTileProfile {
  return current;
}

export function setActiveDemProfilePreference(next: DemTileProfile | null | undefined): void {
  const normalized: DemTileProfile = next === 'terrain' ? 'terrain' : 'default';
  if (normalized === current) return;
  current = normalized;
  for (const listener of listeners) {
    try {
      listener(normalized);
    } catch (error) {
      console.warn('[demProfileBus] listener failed', error);
    }
  }
}

export function subscribeDemProfilePreference(
  listener: (profile: DemTileProfile) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}