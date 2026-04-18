/**
 * Generate a complete, self-contained BRouter profile (BRF) from the
 * Itinerary Panel's basic + expert state.
 *
 * Why a full profile (vs `profile:xxx` URL overrides)?
 *   The stock trekking.brf computes `costfactor` from a fixed cascade
 *   of `if highway=...` rules. There's NO global `assign` that lets you
 *   say "multiply the cost of all roads by N" via the URL. So basic-mode
 *   selects ("Interdire la route", "Prioriser le gravel", ...) had no
 *   effect on routing at all — BRouter happily kept routing on roads.
 *
 *   To make those filters real, we generate a fresh BRF on every state
 *   change, POST it to /api/brouter (cached by content hash → never
 *   uploaded twice for the same input), and route with the returned
 *   `custom_<id>` profile id.
 *
 * Structure of the generated BRF:
 *   1. ---context:global  → all `assign` knobs, including the
 *      RedView-only `user_factor_*` multipliers driven by the panel.
 *   2. ---context:way     → trekking-derived tag pre-computations,
 *      then a costfactor split into:
 *         basecost  = the standard trekking cost cascade,
 *         catfactor = a per-category multiplier (1.0 by default,
 *                     <1 to prefer, >1 to avoid, 10000 to forbid).
 *         costfactor = max( ... access penalties ..., basecost * catfactor )
 *   3. ---context:node    → identical to trekking for traffic-signal
 *      handling.
 *
 * The whole template is a static string; only a handful of `assign`
 * lines are interpolated. This keeps the surface tiny and lets us audit
 * the generated profile by eye.
 */
import type { PrioritiesState, RoadTypesState, RoadPreference } from '../../types';
import type { ExpertProfileState } from '../../expert/types';
import { ALL_PARAMETERS } from '../../expert/parameters';

/* ------------------------------------------------------------------ */
/* RoadPreference → cost multiplier                                    */
/* ------------------------------------------------------------------ */

/**
 * Translate a panel preference into a BRouter cost factor.
 *
 * BRouter's costfactor space is log-scale-ish: 1 = neutral, 1.5 = mild
 * penalty, 5 = strong, 100 = severe. The 10000 sentinel means "edge
 * removed entirely from the graph" — but using it as a multiplier
 * triggers two failure modes: (a) the start/end can't snap to a way
 * because every nearby segment becomes infinite, (b) BRouter explodes
 * its search frontier in dense areas trying to escape the exclusion.
 *
 * IMPORTANT: every factor MUST stay >= 1.0. The stock trekking baseline
 * (and our basecost cascade) yields cost-per-meter >= 1 for every
 * routable surface (cycleroutes are 1.0, the global floor). If we
 * multiply by a factor < 1, the per-meter cost drops below 1, which
 * makes BRouter's A* heuristic (= remaining airdistance × 1) *over*-
 * estimate the true cost. The pass-2 search still completes, but the
 * final "re-tracking" pass (RoutingEngine.searchRoutedTrack, line
 * ~1800) fails to follow the guide track and the upstream returns
 * `error re-tracking track` (HTTP 400). See issue
 * https://github.com/abrensch/brouter/issues/77 for the same class of
 * bug triggered by negative turn-cost.
 *
 * So "prefer" is neutral (= tolerate) — differentiation comes from
 * penalising the *other* categories via avoid / forbid. In practice
 * "prefer road, forbid gravel" still routes overwhelmingly on roads.
 *
 *   - prefer   → 1.0   (was 0.5 — caused HTTP 400 on prefer-road combos)
 *   - tolerate → 1.0
 *   - avoid    → 4.0
 *   - forbid   → 50    (any 100 m forbidden segment costs as much as
 *                       5 km of normal road; almost always avoided)
 */
function prefToFactor(p: RoadPreference): number {
  switch (p) {
    case 'prefer':
      return 1.0;
    case 'tolerate':
      return 1.0;
    case 'avoid':
      return 4.0;
    case 'forbid':
      return 50;
  }
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface BrfBuildInputs {
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  expert?: ExpertProfileState | null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function brfBool(v: unknown): string {
  return v ? 'true' : 'false';
}

function brfNum(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.?0+$/, '');
}

/**
 * Pick a value from the expert state when expert mode is on, otherwise
 * fall back to the parameter's default. Mirrors `expertStateToOverrides`
 * but returns the typed value directly (ready to interpolate in BRF).
 */
function expertValue<T>(
  expert: ExpertProfileState | null | undefined,
  id: string,
  fallback: T,
): T {
  if (!expert || !expert.enabled) return fallback;
  const v = expert.values[id];
  if (v === undefined || v === null) return fallback;
  return v as unknown as T;
}

function defaultFor(id: string): unknown {
  const p = ALL_PARAMETERS.find((p) => p.id === id);
  return p?.default;
}

/* ------------------------------------------------------------------ */
/* Main builder                                                        */
/* ------------------------------------------------------------------ */

export function buildBrfProfile(inputs: BrfBuildInputs): string {
  const { priorities, roadTypes, expert } = inputs;

  // ── Per-category cost multipliers ───────────────────────────────
  // To preserve "prefer X ≠ tolerate X" semantics WITHOUT introducing
  // sub-1.0 cost factors (which break BRouter's re-tracking — see
  // prefToFactor docs), we bump every *tolerate* category up to 1.5
  // when at least one other category is set to "prefer". The preferred
  // category itself stays at 1.0 → relatively cheaper.
  const cats: Array<keyof Pick<RoadTypesState,
    'road' | 'gravel' | 'singletrack' | 'offroad' | 'bikeLanes' | 'majorRoads'>> = [
    'road', 'gravel', 'singletrack', 'offroad', 'bikeLanes', 'majorRoads',
  ];
  const anyPrefer = cats.some((c) => roadTypes[c] === 'prefer');
  const factorFor = (p: RoadPreference): number => {
    if (p === 'tolerate' && anyPrefer) return 1.5;
    return prefToFactor(p);
  };
  const f_road = factorFor(roadTypes.road);
  const f_gravel = factorFor(roadTypes.gravel);
  const f_singletrack = factorFor(roadTypes.singletrack);
  const f_offroad = factorFor(roadTypes.offroad);
  const f_bikelane = factorFor(roadTypes.bikeLanes);
  const f_major = factorFor(roadTypes.majorRoads);
  const allowFerries = roadTypes.ferry !== 'forbid';
  const allowSteps = roadTypes.bikeLanes !== 'forbid' && f_singletrack < 10000;

  // ─── Bipolar slider semantics ─────────────────────────────────────
  // Every priority slider is bipolar around 50:
  //   0   = strong "minus" of the labelled metric
  //   50  = neutral / stock-trekking baseline
  //   100 = strong "plus" of the labelled metric
  //
  // Helper: signed distance from 50 in [-1, +1].
  const sign = (v: number): number =>
    Math.max(-1, Math.min(1, (Math.max(0, Math.min(100, v)) - 50) / 50));

  const sElev = sign(priorities.elevation);    // -1 = flat, +1 = hilly
  const sDist = sign(priorities.distance);     // -1 = shortest, +1 = scenic
  const sDur = sign(priorities.duration);      // -1 = scenic OK, +1 = fastest
  const sTranq = sign(priorities.tranquility); // -1 = traffic OK, +1 = quiet

  // ─── Elevation (Dénivelé) ─────────────────────────────────────────
  // Negative side (sElev < 0): "max-flat" — big uphillcost detours.
  //   sElev=-1 → uphillcost=300, downhillcost=0, cutoff loose
  //   sElev= 0 → uphillcost=60                  (stock baseline)
  // Positive side (sElev > 0): climb-seeker.
  //   sElev<=0.4 (slider <=70): mild climb-friendly bias.
  //   sElev>0.4  (slider > 70): "climbing mode" ported from
  //     earth-explorer-3d (`server/profiles/profileGenerator.ts`):
  //       - uphillcost=0, downhillcost=0 (no penalty at all on D+)
  //       - low elevationpenaltybuffer/elevationmaxbuffer + 100% reduce
  //       - lowered up/downhillcutoff (1.5 → 0.5) so the engine "sees"
  //         small bumps as relief
  //       - flat-road costfactor inflated via `climbMul` (1.0 → 2.5):
  //         every paved/major road becomes more expensive, so the
  //         engine prefers the same routes via cycleways/tracks/passes.
  //   Combined with multi-alternative best-of-N (see `client.ts`),
  //   this is the system that we ship — no Overpass discovery needed.
  let upCost: number;
  let downCost: number;
  let upCutoff: number;
  let downCutoff: number;
  let elevPenaltyBuffer: number;
  let elevMaxBuffer: number;
  let elevBufferReduce: number;
  // climbMul: applied as a road-cost multiplier in climbing mode.
  // 1.0 = no inflation (slider <= 70); 2.5 at slider=100.
  let climbMul = 1.0;
  if (sElev <= 0) {
    upCost = Math.round(60 + (-sElev) * 240); // 60 → 300
    downCost = 0;
    upCutoff = 1.5;
    downCutoff = 1.5;
    elevPenaltyBuffer = 10;
    elevMaxBuffer = 20;
    elevBufferReduce = 0;
  } else if (sElev <= 0.4) {
    // Mild climb-friendly bias only (slider 50..70).
    upCost = Math.round(60 * (1 - sElev * 0.7));   // 60 → ~43
    downCost = 60;
    upCutoff = 1.5;
    downCutoff = 1.5;
    elevPenaltyBuffer = 10;
    elevMaxBuffer = 20;
    elevBufferReduce = 0;
  } else {
    // Climbing mode (slider > 70). EE3D's recipe + an extra-aggressive
    // tier at slider=100 ("max-hilly") tuned to reach ~10 km d+ on
    // big-mountain routes like Chamonix → Grenoble.
    const climbScale = (sElev - 0.4) / 0.6; // 0..1 over slider 70..100
    upCost = 0;
    downCost = 0;
    // Push cutoffs even lower at the top of the slider so that BRouter
    // treats sub-1% slopes as "real" climbs and substitutes in the
    // (very low) uphillcostfactor — this is what lets the engine pick
    // a 30 km detour for 1500 m of relief over the flat valley.
    upCutoff = 1.5 - climbScale * 1.2; // 1.5 → 0.3
    downCutoff = 1.5 - climbScale * 1.2; // 1.5 → 0.3
    // Tighten the elevation accumulator further so even small bumps
    // saturate. Reduce=1.05 means the buffer drains faster than it
    // fills on flat ground → A* keeps "wanting" the next climb.
    elevPenaltyBuffer = 1;
    elevMaxBuffer = 2;
    elevBufferReduce = 1.05;
    // Inflate flat-road costs aggressively at slider=100. At 5.0×, a
    // 1 km of flat valley road costs the same as 5 km of climbing
    // cycleway, so the engine readily adds long detours to gain D+.
    climbMul = 1.0 + climbScale * 4.0; // 1.0 → 5.0  (was 2.5)
  }
  const considerElevation = true;
  // EE3D's secret sauce: in climb mode we widen the A* search via
  // pass1coefficient=1.8 (matches `brouter/profiles2/climbing.brf`)
  // and emit per-highway uphill/downhillcostfactor below so that
  // BRouter REPLACES costfactor with the (low) uphillcostfactor on any
  // segment whose slope saturates the elevation buffer (>0.5% with the
  // tightened buffer). Result: climbing on a track is ~3× cheaper than
  // staying on the flat valley road.
  const inClimbMode = sElev > 0.4;
  const pass1Coefficient = inClimbMode ? 1.8 : 1.5;

  // ─── Max slope cap ────────────────────────────────────────────────
  const maxSlope = Math.min(99, Math.max(1, roadTypes.maxSlopePercent || 99));
  const maxSlopeCost = maxSlope >= 99 ? 0 : 500;

  // ─── Turn cost factor ─────────────────────────────────────────────
  const turnFactor = (() => {
    switch (roadTypes.turns) {
      case 'prefer': return 0.3;
      case 'tolerate': return 1.0;
      case 'avoid': return 4.0;
      case 'forbid': return 50.0;
    }
  })();

  // ─── Distance (Distance) ──────────────────────────────────────────
  // Negative side: shortest path — kill cycleroute detours.
  // Positive side: long scenic — stick to cycleroutes, penalise direct
  // non-cycleroute segments to encourage longer detours through bike
  // infrastructure.
  const ignoreCycleroutes = sDist <= -0.4; // slider ≤ 30
  // user_dist_noncycle_penalty: ×1 to ×2 applied to every non-LDCR segment
  // when the slider is on the "+" side.
  const distNonCyclePenalty =
    sDist > 0 ? 1 + sDist * 1.0 : 1; // 1.0 → 2.0

  // ─── Duration (Durée) ─────────────────────────────────────────────
  // Positive side: minimise time — ignore long-distance cycleroute
  // detours (the trekking baseline gives them basecost=1, which beats
  // even unclassified roads, so the engine happily routes via
  // EuroVelo-style detours that add 30+ km). Also lightly penalise
  // slow surfaces so the route prefers paved roads.
  // Negative side: scenic / slow OK — leave defaults but gently nudge
  // away from the fastest major roads.
  const durIgnoreCycleroutes = sDur >= 0.4; // slider >= 70
  // user_dur_slow_penalty: 1.0 → 1.4 on the "+" side. Very mild —
  // anything stronger triggers paved-road detours that ADD distance
  // and end up TAKING LONGER than the direct path.
  const durSlowPenalty = sDur > 0 ? 1 + sDur * 0.4 : 1;
  // user_dur_fast_penalty: 1.0 → 1.4 on the "-" side, applied to fast
  // major-ish roads so a low duration priority gently nudges away from
  // fastest roads.
  const durFastPenalty = sDur < 0 ? 1 + (-sDur) * 0.4 : 1;
  // user_dur_minor_penalty: 1.0 → 1.2 on the "+" side, very mild bias
  // away from service roads.
  const durMinorPenalty = sDur > 0 ? 1 + sDur * 0.2 : 1;

  // ─── Tranquility (Tranquilité) ────────────────────────────────────
  // Positive side: max-quiet — turn on every consider_* flag and
  // penalise major roads heavily. The trekking flags consider_traffic /
  // consider_town add soft penalties; we add a hard major-road
  // multiplier on top so the slider visibly reroutes through villages.
  const considerTraffic = sTranq >= 0.2;
  const avoidUnsafe = sTranq >= 0.2;
  const tranqConsiderNoise = sTranq >= 0.4;
  const tranqMajorPenalty = sTranq > 0 ? 1 + sTranq * 3.0 : 1; // 1.0 → 4.0

  // Cities: the trekking-style additive `town_penalty` (max +1.6) is
  // far too weak to actually reroute a 100 km trip around villages.
  // We add a real multiplicative `cities_mult` applied to every way
  // tagged with estimated_town_class >= 2 (= built-up area).
  //   tolerate → 1.0   (unchanged)
  //   avoid    → 6.0   (significant detour)
  //   forbid   → 50.0  (only crosses towns when geometrically required)
  const citiesMult =
    roadTypes.cities === 'forbid' ? 50.0 :
    roadTypes.cities === 'avoid'  ? 6.0  :
    sTranq >= 0.6 ? 2.5 :
    1.0;
  const considerTown =
    roadTypes.cities === 'avoid' ||
    roadTypes.cities === 'forbid' ||
    sTranq >= 0.2;
  const tranqStickToCycleroutes = sTranq >= 0.6;

  // Expert overrides (kinematic + advanced) — these flow as raw assigns.
  const totalMass = expertValue(expert, 'totalMass', defaultFor('totalMass') as number);
  const maxSpeed = expertValue(expert, 'maxSpeed', defaultFor('maxSpeed') as number);
  const sCx = expertValue(expert, 'S_C_x', defaultFor('S_C_x') as number);
  const cR = expertValue(expert, 'C_r', defaultFor('C_r') as number);
  const bikerPower = expertValue(expert, 'bikerPower', defaultFor('bikerPower') as number);
  const stickToCycleRoutes = expertValue(expert, 'stick_to_cycleroutes', false);
  const useProposedCycleRoutes = expertValue(expert, 'use_proposed_cycleroutes', false);
  const considerNoise = expertValue(expert, 'consider_noise', false);
  const considerRiver = expertValue(expert, 'consider_river', false);
  const considerForest = expertValue(expert, 'consider_forest', false);
  const turnInstructionMode = expertValue(expert, 'turnInstructionMode', 1);
  const considerTurnRestrictions = expertValue(expert, 'considerTurnRestrictions', true);

  return `# *** RedView dynamic profile (auto-generated) ***
# Generated from the Itinerary Panel state.
# Each route request that changes any panel filter regenerates this file.

---context:global

assign validForBikes = true

# ─── User-controlled per-category cost multipliers ────────────────
assign user_factor_road        = ${brfNum(f_road)}
assign user_factor_gravel      = ${brfNum(f_gravel)}
assign user_factor_singletrack = ${brfNum(f_singletrack)}
assign user_factor_offroad     = ${brfNum(f_offroad)}
assign user_factor_bikelane    = ${brfNum(f_bikelane)}
assign user_factor_major       = ${brfNum(f_major)}
assign user_turn_factor        = ${brfNum(turnFactor)}

# ─── Slider-driven multipliers (way-context applies them) ─────────
# distNonCyclePenalty: applied to every non-LDCR segment when the
# Distance slider is on the "+" side (1.0 → 2.0).
assign user_dist_noncycle_penalty = ${brfNum(distNonCyclePenalty)}
# durSlowPenalty: applied to slow surfaces (paths, tracks, footways)
# when the Durée slider is on the "+" side (1.0 → 3.0).
assign user_dur_slow_penalty      = ${brfNum(durSlowPenalty)}
# durFastPenalty: applied to fast major roads when the Durée slider is
# on the "-" side (1.0 → 1.4).
assign user_dur_fast_penalty      = ${brfNum(durFastPenalty)}
# tranqMajorPenalty: applied to major roads when the Tranquilité
# slider is on the "+" side (1.0 → 4.0).
assign user_tranq_major_penalty   = ${brfNum(tranqMajorPenalty)}
# citiesMult: applied to every way in built-up areas (estimated_town_class >= 2).
assign user_cities_mult           = ${brfNum(citiesMult)}
# durMinorPenalty: applied to service / unclassified ways when the
# Durée slider is on the "+" side (1.0 → 1.8).
assign user_dur_minor_penalty     = ${brfNum(durMinorPenalty)}
# climbMul: applied to road + major-road categories when the Dénivelé
# slider is in climbing mode (>70 → 1.0..2.5). Inflates the cost of
# flat valley roads so the engine prefers detours via passes/cols.
assign user_climb_mul             = ${brfNum(climbMul)}

# ─── Behaviour ────────────────────────────────────────────────────
assign allow_steps              = ${brfBool(allowSteps)}
assign allow_ferries            = ${brfBool(allowFerries)}
assign ignore_cycleroutes       = ${brfBool(ignoreCycleroutes || durIgnoreCycleroutes)}
assign stick_to_cycleroutes     = ${brfBool(stickToCycleRoutes || tranqStickToCycleroutes)}
assign use_proposed_cycleroutes = ${brfBool(useProposedCycleRoutes)}
assign avoid_unsafe             = ${brfBool(avoidUnsafe)}
assign add_beeline              = false
assign consider_noise           = ${brfBool(considerNoise || tranqConsiderNoise)}
assign consider_river           = ${brfBool(considerRiver)}
assign consider_forest          = ${brfBool(considerForest)}
assign consider_town            = ${brfBool(considerTown)}
assign consider_traffic         = ${brfBool(considerTraffic)}

# ─── Elevation ────────────────────────────────────────────────────
assign consider_elevation = ${brfBool(considerElevation)}
assign downhillcost   = ${brfNum(downCost)}
assign downhillcutoff = ${brfNum(downCutoff)}
assign uphillcost     = ${brfNum(upCost)}
assign uphillcutoff   = ${brfNum(upCutoff)}

# Climb-seeker buffers (EE3D recipe). Tighten the elevation accumulator
# in climbing mode so even tiny bumps register as relief.
assign elevationpenaltybuffer = ${brfNum(elevPenaltyBuffer)}
assign elevationmaxbuffer     = ${brfNum(elevMaxBuffer)}
assign elevationbufferreduce  = ${brfNum(elevBufferReduce)}

# Slope-cap: BRouter applies these in the kinematic extra-cost stage.
assign uphillmaxslope         = ${brfNum(maxSlope)}
assign uphillmaxslopecost     = ${brfNum(maxSlopeCost)}
assign downhillmaxslope       = ${brfNum(maxSlope)}
assign downhillmaxslopecost   = ${brfNum(maxSlopeCost)}

# ─── Kinematic model (travel-time computation) ────────────────────
assign totalMass  = ${brfNum(totalMass)}
assign maxSpeed   = ${brfNum(maxSpeed)}
assign S_C_x      = ${brfNum(sCx)}
assign C_r        = ${brfNum(cR)}
assign bikerPower = ${brfNum(bikerPower)}

# ─── Turn instructions ────────────────────────────────────────────
assign turnInstructionMode          = ${brfNum(turnInstructionMode as number)}
assign turnInstructionCatchingRange = 40
assign turnInstructionRoundabouts   = true
assign considerTurnRestrictions     = ${brfBool(considerTurnRestrictions)}

# ─── Engine ───────────────────────────────────────────────────────
assign correctMisplacedViaPoints         = false
assign correctMisplacedViaPointsDistance = 400
assign processUnusedTags                 = false

# Search heuristic: pass1coefficient is the A* heuristic strength of the
# first BRouter pass. In climbing mode we bump it from 1.5 to 1.8 to
# match earth-explorer-3d's climbing.brf — combined with the per-way
# uphillcostfactor block below, this is what produces real D+ on
# best-of-N alternatives instead of all four collapsing on the same
# valley road.
assign pass1coefficient = ${brfNum(pass1Coefficient)}
assign pass2coefficient = 0


---context:way

assign classifier_none  = 1
assign classifier_ferry = 2

# ── Cycle-route detection (verbatim from trekking.brf) ────────────
assign any_cycleroute =
  if not use_proposed_cycleroutes then
     if      route_bicycle_icn=yes then true
     else if route_bicycle_ncn=yes then true
     else if route_bicycle_rcn=yes then true
     else if route_bicycle_lcn=yes then true
     else false
  else
     if      route_bicycle_icn=yes|proposed then true
     else if route_bicycle_ncn=yes|proposed then true
     else if route_bicycle_rcn=yes|proposed then true
     else if route_bicycle_lcn=yes|proposed then true
     else false

assign nodeaccessgranted =
     if any_cycleroute then true
     else lcn=yes

assign is_ldcr =
     if ignore_cycleroutes then false
     else any_cycleroute

# ── Tag bits ──────────────────────────────────────────────────────
# NOTE: avoid cyclestreet and bicycle_road — not present in the
# stock lookups.dat shipped with older BRouter standalone builds.
assign hasbikerouteoraccess =
       or bicycle=yes|permissive|designated lcn=yes

assign hascycleway = not
  and ( or cycleway= cycleway=no|none )
  and ( or cycleway:left= cycleway:left=no )
      ( or cycleway:right= cycleway:right=no )

assign isbike    = or hasbikerouteoraccess hascycleway
assign ispaved   = or surface=paved|asphalt|concrete|paving_stones|sett smoothness=excellent|good
assign isunpaved = not or ispaved or ( and surface= smoothness= ) or surface=fine_gravel|cobblestone smoothness=intermediate|bad
assign probablyGood = or ispaved and ( or isbike highway=footway ) not isunpaved

# ── Turn cost (scaled by user_turn_factor) ────────────────────────
assign turncost = if is_ldcr then 0
                  else if junction=roundabout then 0
                  else multiply 90 user_turn_factor

assign initialclassifier =
     if route=ferry then classifier_ferry
     else classifier_none

assign initialcost =
     if ( equal initialclassifier classifier_ferry ) then 10000
     else 0

# ── Access logic (verbatim from trekking.brf) ─────────────────────
assign defaultaccess =
       if access= then not motorroad=yes
       else if access=private|no then false
       else true

assign bikeaccess =
       if bicycle= then
       (
         if vehicle= then ( if highway=footway then false else defaultaccess )
         else not vehicle=private|no
       )
       else not bicycle=private|no|dismount|use_sidepath

assign footaccess =
       if bicycle=dismount then true
       else if foot= then defaultaccess
       else not foot=private|no|use_sidepath

assign accesspenalty =
       if bikeaccess then 0
       else if footaccess then 4
       else if any_cycleroute then 15
       else if bicycle=use_sidepath then 25
       else 10000

# ── Oneway penalty (simplified from trekking) ─────────────────────
assign badoneway =
       if reversedirection=yes then
         if oneway:bicycle=yes then true
         else if oneway= then junction=roundabout
         else oneway=yes|true|1
       else oneway=-1

assign onewaypenalty =
       if ( badoneway ) then
       (
         if   ( oneway:bicycle=no                            ) then 0
         else if ( not footaccess                            ) then 100
         else if ( junction=roundabout|circular              ) then 60
         else if ( highway=primary|primary_link              ) then 50
         else if ( highway=secondary|secondary_link          ) then 30
         else if ( highway=tertiary|tertiary_link            ) then 20
         else 4.0
       )
       else 0.0

# ── Optional cost penalties (consider_* flags) ────────────────────
assign town_penalty
   switch consider_town
     switch estimated_town_class=  0
     switch estimated_town_class=1  0.5
     switch estimated_town_class=2  0.9
     switch estimated_town_class=3  1.2
     switch estimated_town_class=4  1.3
     switch estimated_town_class=5  1.4
     switch estimated_town_class=6  1.6 99 0

assign traffic_penalty
   switch consider_traffic
      switch estimated_traffic_class=       0
      switch estimated_traffic_class=1|2    0.2
      switch estimated_traffic_class=3      0.4
      switch estimated_traffic_class=4      0.6
      switch estimated_traffic_class=5      0.8
      switch estimated_traffic_class=6|7    1 99 0

assign noise_penalty
   switch consider_noise
     switch estimated_noise_class=  0
     switch estimated_noise_class=1  0.3
     switch estimated_noise_class=2  0.5
     switch estimated_noise_class=3  0.8
     switch estimated_noise_class=4  1.4
     switch estimated_noise_class=5  1.7
     switch estimated_noise_class=6  2 0 0

# ─────────────────────────────────────────────────────────────────
# Road category classification (RedView)
# ─────────────────────────────────────────────────────────────────

assign isresidentialorliving = or highway=residential|living_street living_street=yes

# Cycleway: dedicated bike infrastructure
assign is_bikelane = or highway=cycleway and isresidentialorliving hascycleway

# Major roads: trunk + primary
assign is_major = or highway=trunk|trunk_link highway=primary|primary_link

# Standard road network (paved, secondary→residential excluded if it's a major)
assign is_road_paved =
  if is_major then false
  else if isunpaved then false
  else or highway=secondary|secondary_link
       or highway=tertiary|tertiary_link
       or highway=unclassified
       or isresidentialorliving
          highway=service

# Gravel: unpaved roads + grade1/2 tracks
assign is_gravel =
  or
    and isunpaved
        ( or highway=secondary|secondary_link
          or highway=tertiary|tertiary_link
          or highway=unclassified
             isresidentialorliving )
    and highway=track ( or tracktype=grade1 tracktype=grade2 )

# Off-road: harder tracks + bridleway
assign is_offroad = or highway=bridleway and highway=track ( or tracktype=grade3 or tracktype=grade4 tracktype=grade5 )

# Singletrack: path / footway
assign is_singletrack = highway=path|footway

# Per-category factor (1.0 = neutral)
assign userfactor =
  if is_bikelane    then user_factor_bikelane
  else if is_major       then user_factor_major
  else if is_singletrack then user_factor_singletrack
  else if is_offroad     then user_factor_offroad
  else if is_gravel      then user_factor_gravel
  else if is_road_paved  then user_factor_road
  else 1.0

# ─────────────────────────────────────────────────────────────────
# Slider-driven extra multipliers (Distance / Durée / Tranquilité).
# All factors stay >= 1.0 to keep BRouter's A* heuristic admissible.
# ─────────────────────────────────────────────────────────────────

# "Slow" surfaces we want to penalise when the Durée slider is high.
# Cycleways and grade1 tracks are excluded (they're fast enough).
assign is_slow_surface =
  if is_ldcr then false
  else if highway=cycleway then false
  else if highway=path|footway then true
  else if highway=bridleway then true
  else if highway=track then
  (
    if tracktype=grade1 then false else true
  )
  else false

assign dist_mult      = if is_ldcr         then 1 else user_dist_noncycle_penalty
assign dur_slow_mult  = if is_slow_surface then user_dur_slow_penalty else 1
assign dur_fast_mult  = if is_major        then user_dur_fast_penalty else 1
assign dur_minor_mult = if ( or highway=service highway=unclassified )
                          then user_dur_minor_penalty else 1
assign tranq_mult     = if is_major        then user_tranq_major_penalty else 1

# Cities: hard-multiplier applied to ways inside a built-up area, as
# detected by BRouter's estimated_town_class heuristic. Anything
# class >= 2 (small town -> city centre) is penalised. The trekking
# additive town_penalty is ALSO active when consider_town=true, so
# the two stack: town_penalty for soft preference, cities_mult for the
# explicit "avoid" / "forbid" filter.
assign in_town =
  if estimated_town_class= then false
  else if estimated_town_class=1 then false
  else true
assign cities_mult = if in_town then user_cities_mult else 1

# climb_mult: in climbing mode (slider > 70) we inflate the cost of
# paved/major roads so the engine's best-of-N alternatives spread out
# towards relief instead of all collapsing onto the flattest valley.
# Cycleways, tracks and paths are LEFT ALONE so they become the cheap
# option once the road premium kicks in.
assign climb_mult =
  if is_major       then user_climb_mul
  else if is_road_paved then user_climb_mul
  else 1

assign slider_multiplier =
  multiply dist_mult
  multiply dur_slow_mult
  multiply dur_fast_mult
  multiply dur_minor_mult
  multiply tranq_mult
  multiply cities_mult
          climb_mult

assign combined_factor = multiply userfactor slider_multiplier

# ─────────────────────────────────────────────────────────────────
# basecost — trekking-style cost cascade (without user multipliers)
# ─────────────────────────────────────────────────────────────────
assign basecost =
  if ( and highway= not route=ferry )                  then 10000
  else if ( highway=motorway|motorway_link )           then 10000
  else if ( highway=proposed|abandoned|construction )  then 10000
  else if ( highway=steps )                            then ( if allow_steps then 40 else 10000 )
  else if ( route=ferry )                              then ( if allow_ferries then 5.67 else 10000 )
  else if ( is_ldcr )                                  then 1
  else if ( highway=pedestrian )                       then ( if isbike then ( if hascycleway then 1.1 else 2.2 ) else 3 )
  else if ( highway=bridleway )                        then 5
  else if ( highway=cycleway )                         then 1
  else if ( isresidentialorliving )                    then ( if isunpaved then 1.5 else 1.1 )
  else if ( highway=service )                          then ( if isunpaved then 1.6 else 1.3 )
  else if ( highway=track|road|path|footway ) then
  (
    if      ( tracktype=grade1 ) then ( if probablyGood then 1.0 else 1.3 )
    else if ( tracktype=grade2 ) then ( if probablyGood then 1.1 else 2.0 )
    else if ( tracktype=grade3 ) then ( if probablyGood then 1.5 else 3.0 )
    else if ( tracktype=grade4 ) then ( if probablyGood then 2.0 else 5.0 )
    else if ( tracktype=grade5 ) then ( if probablyGood then 3.0 else 5.0 )
    else                              ( if probablyGood then 1.0 else 5.0 )
  )
  else if ( highway=trunk|trunk_link )         then ( if isbike then 1.5 else 10  )
  else if ( highway=primary|primary_link )     then ( if isbike then 1.2 else  3  )
  else if ( highway=secondary|secondary_link ) then ( if isbike then 1.1 else 1.6 )
  else if ( highway=tertiary|tertiary_link )   then ( if isbike then 1.0 else 1.4 )
  else if ( highway=unclassified )             then ( if isbike then 1.0 else 1.3 )
  else 2.0

# ─────────────────────────────────────────────────────────────────
# Apply user multiplier — but PRESERVE the 10000 sentinel.
# Multiplying 10000 by user_factor_road (0.4 in "prefer") would yield
# 4000, which BRouter would consider routable. So we special-case any
# basecost ≥ 9999 and pass it through unchanged.
# We also clamp the multiplied result to 9999 so post-cascade penalties
# (town, traffic, …) can be added without ever crossing the sentinel
# accidentally.
# ─────────────────────────────────────────────────────────────────
assign weightedbase =
  if greater basecost 9999 then 10000
  else if greater ( multiply combined_factor basecost ) 9999 then 9999
  else multiply combined_factor basecost

# ─────────────────────────────────────────────────────────────────
# Final costfactor: weightedbase + access/oneway + soft penalties.
# ─────────────────────────────────────────────────────────────────
assign costfactor
  add max onewaypenalty accesspenalty
  add town_penalty
  add traffic_penalty
  add noise_penalty
      weightedbase

${inClimbMode ? `# ─── Climbing-mode: per-way uphill/downhill cost factors ──────────
# When the elevation buffer saturates (~1m of gain at slope >0.3% with
# the tightened buffer above), BRouter REPLACES costfactor with
# uphillcostfactor for the slope segment (and downhillcostfactor on the
# way back). Climb-friendly highways (cycleway, track, gravel,
# tertiary…) get values WELL below 1.0 so a kilometre of climbing is
# cheaper than a kilometre of flat valley road (whose costfactor was
# multiplied by user_climb_mul ≤ 5.0 above). Major roads get a punitive
# value so the engine never "climbs" by following a primary road over a
# col when a tertiary alternative exists. Mirrors and extends
# brouter/profiles2/climbing.brf from earth-explorer-3d.
assign uphillcostfactor =
  if is_major            then 6.0
  else if is_road_paved  then 0.7
  else if is_bikelane    then 0.45
  else if is_gravel      then 0.5
  else if is_offroad     then 0.55
  else if is_singletrack then 1.2
  else 0.6

assign downhillcostfactor =
  if is_major            then 6.0
  else if is_road_paved  then 0.7
  else if is_bikelane    then 0.45
  else if is_gravel      then 0.5
  else if is_offroad     then 0.55
  else if is_singletrack then 1.2
  else 0.6
` : ''}
# Voice-hint priority (verbatim trekking)
assign priorityclassifier =
  if      ( highway=motorway                          ) then  30
  else if ( highway=motorway_link                     ) then  29
  else if ( highway=trunk                             ) then  28
  else if ( highway=trunk_link                        ) then  27
  else if ( highway=primary                           ) then  26
  else if ( highway=primary_link                      ) then  25
  else if ( highway=secondary                         ) then  24
  else if ( highway=secondary_link                    ) then  23
  else if ( highway=tertiary                          ) then  22
  else if ( highway=tertiary_link                     ) then  21
  else if ( highway=unclassified                      ) then  20
  else if ( isresidentialorliving                     ) then  6
  else if ( highway=service                           ) then  6
  else if ( highway=cycleway                          ) then  6
  else if ( or bicycle=designated bicycle_road=yes    ) then  6
  else if ( highway=track                             ) then if tracktype=grade1 then 6 else 4
  else if ( highway=bridleway|road|path|footway       ) then  4
  else if ( highway=steps                             ) then  2
  else if ( highway=pedestrian                        ) then  2
  else 0

assign isbadoneway  = not equal onewaypenalty 0
assign isgoodoneway = if reversedirection=yes then oneway=-1
                      else if oneway= then junction=roundabout else oneway=yes|true|1
assign isroundabout = junction=roundabout
assign islinktype   = highway=motorway_link|trunk_link|primary_link|secondary_link|tertiary_link
assign isgoodforcars = if greater priorityclassifier 6 then true
                  else if ( or isresidentialorliving highway=service ) then true
                  else if ( and highway=track tracktype=grade1 ) then true
                  else false

assign classifiermask add          isbadoneway
                      add multiply isgoodoneway   2
                      add multiply isroundabout   4
                      add multiply islinktype     8
                          multiply isgoodforcars 16


---context:node

assign defaultaccess =
       if ( access= ) then true
       else if ( access=private|no ) then false
       else true

assign bikeaccess =
       if nodeaccessgranted=yes then true
       else if bicycle= then
       (
         if vehicle= then defaultaccess
         else not vehicle=private|no
       )
       else not bicycle=private|no|dismount

assign footaccess =
       if bicycle=dismount then true
       else if foot= then defaultaccess
       else not foot=private|no

assign initialcost =
       if or highway=traffic_signals and highway=crossing crossing=traffic_signals then 20
       else
       if bikeaccess then 0
       else ( if footaccess then 100 else 1000000 )
`;
}

/* ------------------------------------------------------------------ */
/* Stable hash for caching                                             */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash → 8-char hex. Plenty of entropy to dedup uploads. */
export function hashBrf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
