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
import type { BrfBuildInputs } from './brf-template/types';
import { resolveBrfProfileValues } from './brf-template/values';

export type { BrfBuildInputs } from './brf-template/types';

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

/* ------------------------------------------------------------------ */
/* Main builder                                                        */
/* ------------------------------------------------------------------ */

export function buildBrfProfile(inputs: BrfBuildInputs): string {
  const {
    fRoad,
    fGravel,
    fSingletrack,
    fOffroad,
    fBikelane,
    fMajor,
    allowFerries,
    allowSteps,
    shortestMode,
    turnFactor,
    distDetourRelief,
    distDirectPenalty,
    durSlowPenalty,
    durFastPenalty,
    durMinorPenalty,
    tranqMajorPenalty,
    tranqFastTrafficPenalty,
    tranqBackgroundPenalty,
    citiesMult,
    climbMul,
    ignoreCycleroutes,
    stickToCycleRoutes,
    useProposedCycleRoutes,
    avoidUnsafe,
    considerNoise,
    considerRiver,
    considerForest,
    considerTown,
    considerTraffic,
    considerElevation,
    signalPenalty,
    townPenaltyScale,
    trafficPenaltyScale,
    forestReliefByClass,
    riverReliefByClass,
    downCost,
    downCutoff,
    upCost,
    upCutoff,
    elevPenaltyBuffer,
    elevMaxBuffer,
    elevBufferReduce,
    pass1Coefficient,
    inClimbMode,
    maxSlope,
    maxSlopeCost,
    totalMass,
    maxSpeed,
    sCx,
    cR,
    bikerPower,
    turnInstructionMode,
    considerTurnRestrictions,
  } = resolveBrfProfileValues(inputs);

  return `# *** RedView dynamic profile (auto-generated) ***
# Generated from the Itinerary Panel state.
# Each route request that changes any panel filter regenerates this file.

---context:global

assign validForBikes = true

# ─── User-controlled per-category cost multipliers ────────────────
assign user_factor_road        = ${brfNum(fRoad)}
assign user_factor_gravel      = ${brfNum(fGravel)}
assign user_factor_singletrack = ${brfNum(fSingletrack)}
assign user_factor_offroad     = ${brfNum(fOffroad)}
assign user_factor_bikelane    = ${brfNum(fBikelane)}
assign user_factor_major       = ${brfNum(fMajor)}
assign user_turn_factor        = ${brfNum(turnFactor)}

# ─── Slider-driven multipliers (way-context applies them) ─────────
# distDetourRelief/directPenalty: at Distance "+", scenic side roads,
# gravel, tracks and paths become cheap while direct car roads become
# expensive enough for BRouter to accept real detours.
assign user_dist_detour_relief    = ${brfNum(distDetourRelief)}
assign user_dist_direct_penalty   = ${brfNum(distDirectPenalty)}
# durSlowPenalty: applied to slow surfaces (paths, tracks, footways)
# when the Durée slider is on the "+" side (1.0 → 2.35).
assign user_dur_slow_penalty      = ${brfNum(durSlowPenalty)}
# durFastPenalty: applied to fast major roads when the Durée slider is
# on the "-" side (1.0 → 1.55).
assign user_dur_fast_penalty      = ${brfNum(durFastPenalty)}
# signalPenalty: node initial-cost for traffic lights / stops when
# the Durée slider is on the "+" side.
assign user_signal_penalty        = ${brfNum(signalPenalty)}
# tranqMajorPenalty: applied to major roads when the Tranquilité
# slider is on the "+" side.
assign user_tranq_major_penalty   = ${brfNum(tranqMajorPenalty)}
# tranqFastTrafficPenalty: heavy tax for 80+ km/h / high-class traffic roads.
assign user_tranq_fast_penalty    = ${brfNum(tranqFastTrafficPenalty)}
# tranqBackgroundPenalty: soft penalty for roads outside green/river
# corridors when Tranquilité is pushed to the right.
assign user_tranq_background_penalty = ${brfNum(tranqBackgroundPenalty)}
# citiesMult: applied to every way in built-up areas (estimated_town_class >= 2).
assign user_cities_mult           = ${brfNum(citiesMult)}
# town/traffic penalty scales: stack on top of the pseudo-tag penalties.
assign user_town_penalty_scale    = ${brfNum(townPenaltyScale)}
assign user_traffic_penalty_scale = ${brfNum(trafficPenaltyScale)}
# durMinorPenalty: applied to service / unclassified ways when the
# Durée slider is on the "+" side (1.0 → 1.65).
assign user_dur_minor_penalty     = ${brfNum(durMinorPenalty)}
# climbMul: flat-tax multiplier in climbing mode. Flat segments use the
# normal costfactor, climbs use uphillcostfactor below. We therefore tax
# the flat graph heavily instead of rewarding climbing with fake negative
# incentives.
assign user_climb_mul             = ${brfNum(climbMul)}

# ─── Behaviour ────────────────────────────────────────────────────
assign allow_steps              = ${brfBool(allowSteps)}
assign allow_ferries            = ${brfBool(allowFerries)}
assign shortest_mode            = ${brfBool(shortestMode)}
assign ignore_cycleroutes       = ${brfBool(ignoreCycleroutes)}
assign stick_to_cycleroutes     = ${brfBool(stickToCycleRoutes)}
assign use_proposed_cycleroutes = ${brfBool(useProposedCycleRoutes)}
assign avoid_unsafe             = ${brfBool(avoidUnsafe)}
assign add_beeline              = false
assign consider_noise           = ${brfBool(considerNoise)}
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

# Search heuristic: keep the A* heuristic conservative in climbing mode.
# The D+ effect comes from the flat-tax costfactor and best-of-N spread,
# not from rewarding uphill loops.
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
assign raw_town_penalty
   switch consider_town
     switch estimated_town_class=  0
     switch estimated_town_class=1  0.5
     switch estimated_town_class=2  0.9
     switch estimated_town_class=3  1.2
     switch estimated_town_class=4  1.3
     switch estimated_town_class=5  1.4
     switch estimated_town_class=6  1.6 99 0

assign town_penalty = multiply raw_town_penalty user_town_penalty_scale

assign raw_traffic_penalty
   switch consider_traffic
      switch estimated_traffic_class=       0
      switch estimated_traffic_class=1|2    0.2
      switch estimated_traffic_class=3      0.4
      switch estimated_traffic_class=4      0.6
      switch estimated_traffic_class=5      0.8
      switch estimated_traffic_class=6|7    1 99 0

assign traffic_penalty = multiply raw_traffic_penalty user_traffic_penalty_scale

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

# Rough / indirect surfaces: when the Distance slider goes right, we
# stop romanticising the road quality and penalise segments that tend to
# generate scenic detours.
assign is_distance_detour_surface =
  if is_ldcr then false
  else if is_major then false
  else if is_bikelane then false
  else if is_road_paved then false
  else if is_gravel then true
  else if is_offroad then true
  else if is_singletrack then true
  else if highway=track|path|footway|bridleway then true
  else false

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

assign forest_relief =
  if not consider_forest then 1
  else if estimated_forest_class=6 then ${brfNum(forestReliefByClass[5])}
  else if estimated_forest_class=5 then ${brfNum(forestReliefByClass[4])}
  else if estimated_forest_class=4 then ${brfNum(forestReliefByClass[3])}
  else if estimated_forest_class=3 then ${brfNum(forestReliefByClass[2])}
  else if estimated_forest_class=2 then ${brfNum(forestReliefByClass[1])}
  else ${brfNum(forestReliefByClass[0])}

assign river_relief =
  if not consider_river then 1
  else if estimated_river_class=6 then ${brfNum(riverReliefByClass[5])}
  else if estimated_river_class=5 then ${brfNum(riverReliefByClass[4])}
  else if estimated_river_class=4 then ${brfNum(riverReliefByClass[3])}
  else if estimated_river_class=3 then ${brfNum(riverReliefByClass[2])}
  else if estimated_river_class=2 then ${brfNum(riverReliefByClass[1])}
  else ${brfNum(riverReliefByClass[0])}

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

assign is_direct_distance_road =
  if is_major then true
  else if highway=secondary|secondary_link then true
  else if highway=tertiary|tertiary_link then true
  else if highway=unclassified then true
  else false

assign is_fast_traffic_way =
  if highway=trunk|trunk_link|primary|primary_link then true
  else if maxspeed=80|90|100|110|120|130 then true
  else if estimated_traffic_class=5|6|7 then true
  else false

assign dist_mult      = if is_distance_detour_surface then user_dist_detour_relief
                        else if is_direct_distance_road then user_dist_direct_penalty
                        else 1
assign dur_slow_mult  = if is_slow_surface then user_dur_slow_penalty else 1
assign dur_fast_mult  = if is_major        then user_dur_fast_penalty else 1
assign dur_minor_mult = if ( or highway=service highway=unclassified )
                          then user_dur_minor_penalty else 1
assign tranq_mult     = if is_fast_traffic_way then user_tranq_fast_penalty
                        else if is_major then user_tranq_major_penalty
                        else if in_town then user_tranq_background_penalty
                        else multiply forest_relief river_relief

assign cities_mult = if in_town then user_cities_mult else 1

# climb_mult: flat-tax mode. Only flat-ish segments use this costfactor;
# real ascents switch to the uphillcostfactor block below. This avoids
# infinite fake D+ rewards while still making valleys unattractive.
assign climb_mult =
  if route=ferry then 1
  else if highway=steps then 1
  else if highway= then 1
  else user_climb_mul

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
  else if shortest_mode then
  (
    if greater ( multiply userfactor 1 ) 9999 then 9999
    else multiply userfactor 1
  )
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
# Climbing mode taxes flat segments above via climb_mult. Uphill factors
# stay positive and ordinary: we do not reward ascent, we simply stop flat
# valley roads from being the cheapest option.
assign uphillcostfactor =
  if is_major            then 4.0
  else if is_road_paved  then 1.45
  else if is_bikelane    then 1.1
  else if is_gravel      then 1.15
  else if is_offroad     then 1.35
  else if is_singletrack then 2.2
  else 1.5

assign downhillcostfactor = 0
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
  if or highway=traffic_signals and highway=crossing crossing=traffic_signals then user_signal_penalty
  else if highway=stop then multiply user_signal_penalty 0.35
  else if highway=give_way then multiply user_signal_penalty 0.2
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
