// ============================================
// LiDAR viewer tools — measurements from picked points
// ============================================

import { computeAreaStats } from '../terrain/areaStats';
import { computeProfile } from '../terrain/profile';
import type { TerrainField } from '../terrain/terrainField';
import { computeViewshed } from '../terrain/viewshed';
import type { ScenePick, ToolId } from '../types';
import type { Measurement } from './types';

/** Vertices a drawing tool needs before it can be finished. */
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
 * Builds the measurement of `tool` from its picks (one for the point tools).
 * `null` when the picks cannot give one (too few, or off the ground model).
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
      // Asynchronous (ground cover from the point cloud, seconds of compute): see the controller.
      return null;
    case 'viewshed': {
      const result = computeViewshed(field, first.projX, first.projY);
      return result ? { id, kind: 'viewshed', origin: first, result } : null;
    }
    case 'pin':
      return { id, kind: 'pin', at: first };
  }
}
