/**
 * Generate a complete, self-contained BRouter profile (BRF) from the
 * Itinerary Panel's basic + expert state.
 */
import type { BrfBuildInputs } from './brf-template/types';
import { resolveBrfProfileValues } from './brf-template/values';
import { buildBrfWayContext } from './brf-template/brfWayContext';
import { BRF_NODE_CONTEXT } from './brf-template/brfNodeContext';

export type { BrfBuildInputs } from './brf-template/types';

function brfBool(v: unknown): string {
  return v ? 'true' : 'false';
}

function brfNum(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.?0+$/, '');
}

/**
 * Construit le profil BRF complet (Global + Way + Node) pour injection dans le serveur BRouter.
 */
export function buildBrfProfile(inputs: BrfBuildInputs): string {
  const values = resolveBrfProfileValues(inputs);

  const globalContext = `# *** RedView dynamic profile (auto-generated) ***
# Generated from the Itinerary Panel state.
# Each route request that changes any panel filter regenerates this file.

---context:global

assign validForBikes = true

# ─── User-controlled per-category cost multipliers ────────────────
assign user_factor_road        = ${brfNum(values.fRoad)}
assign user_factor_gravel      = ${brfNum(values.fGravel)}
assign user_factor_singletrack = ${brfNum(values.fSingletrack)}
assign user_factor_offroad     = ${brfNum(values.fOffroad)}
assign user_factor_bikelane    = ${brfNum(values.fBikelane)}
assign user_factor_major       = ${brfNum(values.fMajor)}
assign user_turn_factor        = ${brfNum(values.turnFactor)}

# ─── Slider-driven multipliers (way-context applies them) ─────────
assign user_dist_detour_relief    = ${brfNum(values.distDetourRelief)}
assign user_dist_direct_penalty   = ${brfNum(values.distDirectPenalty)}
assign user_dur_slow_penalty      = ${brfNum(values.durSlowPenalty)}
assign user_dur_fast_penalty      = ${brfNum(values.durFastPenalty)}
assign user_signal_penalty        = ${brfNum(values.signalPenalty)}
assign user_tranq_major_penalty   = ${brfNum(values.tranqMajorPenalty)}
assign user_tranq_fast_penalty    = ${brfNum(values.tranqFastTrafficPenalty)}
assign user_tranq_background_penalty = ${brfNum(values.tranqBackgroundPenalty)}
assign user_cities_mult           = ${brfNum(values.citiesMult)}
assign user_town_penalty_scale    = ${brfNum(values.townPenaltyScale)}
assign user_traffic_penalty_scale = ${brfNum(values.trafficPenaltyScale)}
assign user_dur_minor_penalty     = ${brfNum(values.durMinorPenalty)}
assign user_climb_mul             = ${brfNum(values.climbMul)}

# ─── Behaviour ────────────────────────────────────────────────────
assign allow_steps              = ${brfBool(values.allowSteps)}
assign allow_ferries            = ${brfBool(values.allowFerries)}
assign shortest_mode            = ${brfBool(values.shortestMode)}
assign ignore_cycleroutes       = ${brfBool(values.ignoreCycleroutes)}
assign stick_to_cycleroutes     = ${brfBool(values.stickToCycleRoutes)}
assign use_proposed_cycleroutes = ${brfBool(values.useProposedCycleRoutes)}
assign avoid_unsafe             = ${brfBool(values.avoidUnsafe)}
assign add_beeline              = false
assign consider_noise           = ${brfBool(values.considerNoise)}
assign consider_river           = ${brfBool(values.considerRiver)}
assign consider_forest          = ${brfBool(values.considerForest)}
assign consider_town            = ${brfBool(values.considerTown)}
assign consider_traffic         = ${brfBool(values.considerTraffic)}

# ─── Elevation ────────────────────────────────────────────────────
assign consider_elevation = ${brfBool(values.considerElevation)}
assign downhillcost   = ${brfNum(values.downCost)}
assign downhillcutoff = ${brfNum(values.downCutoff)}
assign uphillcost     = ${brfNum(values.upCost)}
assign uphillcutoff   = ${brfNum(values.upCutoff)}

assign elevationpenaltybuffer = ${brfNum(values.elevPenaltyBuffer)}
assign elevationmaxbuffer     = ${brfNum(values.elevMaxBuffer)}
assign elevationbufferreduce  = ${brfNum(values.elevBufferReduce)}

assign uphillmaxslope         = ${brfNum(values.maxSlope)}
assign uphillmaxslopecost     = ${brfNum(values.maxSlopeCost)}
assign downhillmaxslope       = ${brfNum(values.maxSlope)}
assign downhillmaxslopecost   = ${brfNum(values.maxSlopeCost)}

# ─── Kinematic model (travel-time computation) ────────────────────
assign totalMass  = ${brfNum(values.totalMass)}
assign maxSpeed   = ${brfNum(values.maxSpeed)}
assign S_C_x      = ${brfNum(values.sCx)}
assign C_r        = ${brfNum(values.cR)}
assign bikerPower = ${brfNum(values.bikerPower)}

# ─── Turn instructions ────────────────────────────────────────────
assign turnInstructionMode          = ${brfNum(values.turnInstructionMode as number)}
assign turnInstructionCatchingRange = 40
assign turnInstructionRoundabouts   = true
assign considerTurnRestrictions     = ${brfBool(values.considerTurnRestrictions)}

# ─── Engine ───────────────────────────────────────────────────────
assign correctMisplacedViaPoints         = false
assign correctMisplacedViaPointsDistance = 400
assign processUnusedTags                 = false
assign pass1coefficient = ${brfNum(values.pass1Coefficient)}
assign pass2coefficient = ${brfNum(values.pass2Coefficient)}
`;

  const wayContext = buildBrfWayContext({
    forestReliefByClass: values.forestReliefByClass,
    riverReliefByClass: values.riverReliefByClass,
    inClimbMode: values.inClimbMode,
    brfNum,
  });

  return `${globalContext}\n\n${wayContext}\n${BRF_NODE_CONTEXT}`;
}

/** FNV-1a 32-bit hash → 8-char hex. Plenty of entropy to dedup uploads. */
export function hashBrf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
