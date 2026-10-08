// ============================================
// Outils du viewer LiDAR — mesures à partir des points choisis
// ============================================

import { computeAreaStats } from '../terrain/areaStats';
import { computeProfile } from '../terrain/profile';
import type { TerrainField } from '../terrain/terrainField';
import { computeViewshed } from '../terrain/viewshed';
import type { ScenePick, ToolId } from '../types';
import type { Measurement } from './types';

/** Sommets dont un outil de dessin a besoin avant de pouvoir être terminé. */
export const MIN_VERTICES: Record<'distance' | 'height' | 'area' | 'profile', number> = {
  distance: 2,
  height: 2,
  area: 3,
  profile: 2,
};

let nextId = 1;

export function nextMeasurementId(): string {
  return `m${nextId++}`;
}

/**
 * Construit la mesure de `tool` à partir de ses points (un seul pour les outils
 * ponctuels). `null` quand les points ne permettent pas d'en tirer une (trop
 * peu, ou hors du modèle de sol).
 */
export function createMeasurement(tool: ToolId, picks: readonly ScenePick[], field: TerrainField): Measurement | null {
  const id = nextMeasurementId();
  const first = picks[0];
  if (!first) return null;
  switch (tool) {
    case 'distance':
      if (picks.length < MIN_VERTICES.distance) return null;
      return { id, kind: 'distance', vertices: [...picks], profile: computeProfile(field, picks) };
    case 'height':
      if (picks.length < 2) return null;
      return { id, kind: 'height', a: first, b: picks[1]! };
    case 'area':
      if (picks.length < MIN_VERTICES.area) return null;
      return { id, kind: 'area', vertices: [...picks], stats: computeAreaStats(field, picks) };
    case 'profile': {
      const profile = computeProfile(field, picks);
      return profile ? { id, kind: 'profile', vertices: [...picks], profile } : null;
    }
    case 'fallLine':
    case 'avalanche':
      // Asynchrone (couvert du sol d'après le nuage de points, des secondes de calcul) : voir le contrôleur.
      return null;
    case 'viewshed': {
      const result = computeViewshed(field, first.projX, first.projY);
      return result ? { id, kind: 'viewshed', origin: first, result } : null;
    }
    case 'pin':
      return { id, kind: 'pin', at: first };
  }
}
