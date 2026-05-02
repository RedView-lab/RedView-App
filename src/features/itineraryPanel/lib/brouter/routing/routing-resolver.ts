/**
 * Top-level orchestrator for the BRouter routing pipeline.
 *
 *   resolveItineraryRouting(itinerary)
 *     → builds a BRF from the itinerary's basic + expert state,
 *     → uploads it (cached by content hash),
 *     → returns the `{ profileId, warnings, brf }` to use in
 *       `fetchBrouterRoute({ profile: profileId })`.
 *
 * If the itinerary has nothing to customise (everything at defaults
 * AND no expert mode active) we shortcut to the stock `trekking`
 * profile so we don't pollute the cache.
 */
import type { Itinerary } from '../../../types';
import type { ExpertProfileState } from '../../../expert/types';
import { buildBrfProfile } from '../profiles/brf-template';
import { ensureProfileUploaded } from '../profiles/profile-cache';
import {
  resolveRoadTypes,
  type RoadTypesResolution,
} from './road-types-resolver';
import { DEFAULT_PROFILE } from '../types';

export interface ResolvedRouting {
  /** Profile id to pass to BRouter (`trekking` or `custom_<id>`). */
  profileId: string;
  /** Resolution of the road-type filters (warnings + auto-corrections). */
  roadTypes: RoadTypesResolution;
  /** The generated BRF text (null when we kept the stock profile). */
  brf: string | null;
}

/**
 * True when the itinerary's basic state matches the trekking defaults
 * AND expert mode is off → no custom profile needed.
 */
function isAllDefault(it: Itinerary, expert?: ExpertProfileState | null): boolean {
  if (expert?.enabled) return false;
  const r = it.roadTypes;
  if (
    r.road !== 'tolerate' ||
    r.gravel !== 'tolerate' ||
    r.singletrack !== 'tolerate' ||
    r.offroad !== 'tolerate' ||
    r.bikeLanes !== 'tolerate' ||
    r.majorRoads !== 'tolerate' ||
    r.ferry !== 'tolerate' ||
    r.turns !== 'tolerate' ||
    r.cities !== 'tolerate'
  ) {
    return false;
  }
  if ((r.maxSlopePercent ?? 99) < 99) return false;
  const p = it.priorities;
  // "Tranquilité 50, Dénivelé 50, Distance 50, Durée 50" = neutral defaults.
  if (
    Math.abs((p.tranquility ?? 50) - 50) > 5 ||
    Math.abs((p.elevation ?? 50) - 50) > 5 ||
    Math.abs((p.duration ?? 50) - 50) > 5 ||
    Math.abs((p.distance ?? 50) - 50) > 5
  ) {
    return false;
  }
  return true;
}

export async function resolveItineraryRouting(
  it: Itinerary,
  signal?: AbortSignal,
): Promise<ResolvedRouting> {
  const expert = it.expertProfile ?? null;
  const roadTypes = resolveRoadTypes(it.roadTypes);

  if (isAllDefault(it, expert) && roadTypes.warnings.length === 0) {
    return { profileId: DEFAULT_PROFILE, roadTypes, brf: null };
  }

  const brf = buildBrfProfile({
    priorities: it.priorities,
    roadTypes: roadTypes.effective,
    expert,
  });
  const profileId = await ensureProfileUploaded(brf, signal);
  return { profileId, roadTypes, brf };
}
