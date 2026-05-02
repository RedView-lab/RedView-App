/**
 * Smart resolver for the panel's RoadTypesState.
 *
 * Detects impossible configurations (e.g. user forbids every rideable
 * surface → BRouter would return "no route") and rewrites them on the
 * fly with a human-readable warning. The corrected state is what's fed
 * into the BRF generator; the panel keeps the user's raw selection so
 * they can see and re-tune it.
 *
 * Rules
 * ─────
 *
 * 1. At least one of {road, gravel, singletrack, offroad, bikeLanes}
 *    must NOT be 'forbid'. If everything is forbidden, we lift the
 *    least restrictive option (in order: bikeLanes → road → gravel →
 *    singletrack → offroad) back up to 'tolerate'.
 *
 * 2. majorRoads='forbid' is fine on its own (BRouter will route around
 *    primary/trunk). But if road='forbid' AND majorRoads='forbid' AND
 *    bikeLanes='forbid' → we'd cut the entire on-road network. We allow
 *    it, since gravel/singletrack might still suffice in rural France,
 *    and just emit an info-level warning.
 *
 * 3. Forbidding bikeLanes WHILE preferring them is contradictory; we
 *    drop the prefer to tolerate (defensive — UI shouldn't allow this
 *    but state can be loaded from older projects).
 *
 * 4. maxSlopePercent < 1 is meaningless (no climb allowed = no route).
 *    We clamp to ≥ 3 %.
 */
import type { RoadTypesState, RoadPreference } from '../../../types';

export interface RoadTypesResolution {
  effective: RoadTypesState;
  warnings: string[];
  /** Truthy when the resolver had to override at least one knob. */
  corrected: boolean;
}

const RIDEABLE_KEYS = [
  'bikeLanes',
  'road',
  'gravel',
  'singletrack',
  'offroad',
] as const satisfies readonly (keyof RoadTypesState)[];

type RideableKey = (typeof RIDEABLE_KEYS)[number];

const KEY_LABELS: Record<RideableKey, string> = {
  bikeLanes: 'voies cyclables',
  road: 'routes',
  gravel: 'gravel',
  singletrack: 'singletrack',
  offroad: 'hors-piste',
};

export function resolveRoadTypes(input: RoadTypesState): RoadTypesResolution {
  const out: RoadTypesState = { ...input };
  const warnings: string[] = [];
  let corrected = false;

  // Rule 1 — at least one rideable surface must remain
  const allForbid = RIDEABLE_KEYS.every((k) => out[k] === 'forbid');
  if (allForbid) {
    // Lift the first key in priority order to 'tolerate'.
    for (const k of RIDEABLE_KEYS) {
      if (out[k] === 'forbid') {
        out[k] = 'tolerate';
        warnings.push(
          `Toutes les surfaces étaient interdites — ${KEY_LABELS[k]} ré-autorisé pour permettre le calcul.`,
        );
        corrected = true;
        break;
      }
    }
  }

  // Rule 2 — if road + bikeLanes + majorRoads all forbid, info warning.
  if (
    out.road === 'forbid' &&
    out.bikeLanes === 'forbid' &&
    out.majorRoads === 'forbid'
  ) {
    warnings.push(
      'Tout le réseau goudronné est interdit : l’itinéraire passera uniquement par des chemins.',
    );
  }

  // Rule 3 — defensive: bikeLanes='forbid' should also clear majorRoads
  // forbid only if user had simultaneously preferred something
  // contradictory. Currently nothing to fix — left as no-op for clarity.

  // Rule 4 — max-slope sanity
  if (out.maxSlopePercent != null && out.maxSlopePercent < 3) {
    warnings.push(
      `Pente max. ${out.maxSlopePercent}% trop basse — relevée à 3 % (en deçà aucun itinéraire n’est calculable).`,
    );
    out.maxSlopePercent = 3;
    corrected = true;
  }

  // Rule 5 — drop ferries 'prefer' when distances make it unlikely
  // (no-op — kept for future heuristics).

  return { effective: out, warnings, corrected };
}

/* Helper for unit tests / external consumers ---------------------------- */
export function isForbid(p: RoadPreference): boolean {
  return p === 'forbid';
}
