/**
 * Map the user-facing Itinerary Panel state to BRouter URL parameters.
 *
 * Two layers compose the final URL:
 *
 *   1. The selected preset profile id ("gravel-default", "road", …) →
 *      a canonical BRouter profile filename (`trekking`, `fastbike`, …).
 *
 *   2. A bag of `profile:xxx` overrides built from:
 *        a. the basic Traçage controls (sliders + select rows),
 *        b. the Expert Mode state (when the user opted in for it).
 *
 * Anything declared in `Itinerary.expertProfile` wins over the
 * basic-mode mapping for the same key — Expert is always the source of
 * truth when present.
 */
import type {
  Itinerary,
  PrioritiesState,
  RoadPreference,
  RoadTypesState,
} from '../../types';
import type { ExpertProfileState } from '../../expert/types';
import { expertStateToOverrides } from '../../expert/state-to-overrides';
import type { BrouterParamOverrides, RedviewProfileId } from './types';

/** Convert the panel-side preset id to an actual BRouter profile name. */
export function panelProfileToBrouter(panelProfileId: string): string {
  switch (panelProfileId as RedviewProfileId) {
    case 'gravel-default':
      return 'trekking';
    case 'road':
      return 'fastbike';
    case 'mtb':
      return 'mtb';
    case 'touring':
      return 'trekking';
    case 'custom':
      return 'trekking';
    default:
      return 'trekking';
  }
}

/* ------------------------------------------------------------------ */
/* Basic-mode mapping — sliders + 9 selects + max-slope                */
/* ------------------------------------------------------------------ */

/** RoadPreference → coarse cost multiplier. Higher = more strongly avoided. */
function prefToFactor(p: RoadPreference): number {
  switch (p) {
    case 'prefer':
      return 0.7;
    case 'tolerate':
      return 1.0;
    case 'avoid':
      return 2.5;
    case 'forbid':
      return 10000;
  }
}

/**
 * Translate the basic Traçage state into `profile:xxx` overrides on the
 * trekking-style base profile.
 *
 * The mappings below use ONLY parameters declared as `assign` in the
 * stock trekking.brf, so they can be overridden via the `profile:xxx`
 * URL syntax without uploading a custom profile.
 */
export function basicStateToOverrides(
  priorities: PrioritiesState,
  roads: RoadTypesState,
): BrouterParamOverrides {
  const o: BrouterParamOverrides = {};

  // ── Priorities ────────────────────────────────────────────────────
  // "Dénivelé" slider: 0 = hilly OK, 100 = flat-as-possible.
  // We translate it to uphill/downhill cost (default 60 in trekking).
  o.consider_elevation = priorities.elevation > 25 ? 'true' : 'false';
  if (priorities.elevation > 25) {
    const k = priorities.elevation / 50; // 0.5..2 around the default.
    o.uphillcost = String(Math.round(60 * k));
    o.downhillcost = String(Math.round(60 * k));
  }

  // "Tranquilité" → bias toward consider_traffic + town avoidance.
  if (priorities.tranquility > 60) {
    o.consider_traffic = 'true';
    o.consider_town = 'true';
    o.avoid_unsafe = 'true';
  } else if (priorities.tranquility < 25) {
    o.consider_traffic = 'false';
    o.consider_town = 'false';
    o.avoid_unsafe = 'false';
  }

  // "Distance" → shortcut: lower = avoid detours via cycle routes.
  if (priorities.distance < 30) {
    o.ignore_cycleroutes = 'true';
  }

  // ── Road types ────────────────────────────────────────────────────
  // We can't redefine the costfactor table from the URL, but the trekking
  // profile already exposes a number of toggles we can flip.
  if (roads.ferry === 'forbid') o.allow_ferries = 'false';
  if (roads.ferry === 'prefer') o.allow_ferries = 'true';

  // Gravel/singletrack/offroad influence: surface & track preferences live
  // inside the BRF body. Use the closest exposed knob — `consider_elevation`
  // already covers tracks indirectly. We expose these as Expert-only.

  // ── Slope cap ────────────────────────────────────────────────────
  // NOTE: `uphillmaxslope` / `downhillmaxslope` / *cost are NOT declared as
  // global `assign` in stock trekking.brf, so sending them as URL overrides
  // makes BRouter throw "unknown variable" → HTTP 422. The slope cap is
  // therefore enforced post-route client-side (see route-layer / fitPredictor)
  // rather than via the BRouter cost function. To use it server-side the
  // user must switch to Expert Mode and upload a custom profile.
  void roads.maxSlopePercent;

  // Discourage steps when on road preset.
  if (roads.bikeLanes === 'forbid') o.allow_steps = '0';

  // Tag for analytics. Multiply factor — currently informational.
  // (Not actually consumed by BRouter, but keeps the URL stable while we
  //  experiment.) We append a synthetic key for debugging only.
  void prefToFactor;

  return o;
}

/* ------------------------------------------------------------------ */
/* Expert-mode mapping                                                 */
/* ------------------------------------------------------------------ */

export function buildOverridesForItinerary(
  it: Itinerary,
  expert?: ExpertProfileState | null,
): BrouterParamOverrides {
  const base = basicStateToOverrides(it.priorities, it.roadTypes);
  if (!expert || !expert.enabled) return base;
  return { ...base, ...expertStateToOverrides(expert) };
}
