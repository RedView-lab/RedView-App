interface BrfWayContextOptions {
  forestReliefByClass: number[];
  riverReliefByClass: number[];
  inClimbMode: boolean;
  brfNum: (v: number, digits?: number) => string;
}

/**
 * Génère la section ---context:way du profil BRF BRouter.
 */
export function buildBrfWayContext({
  forestReliefByClass,
  riverReliefByClass,
  inClimbMode,
  brfNum,
}: BrfWayContextOptions): string {
  return `---context:way

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

assign ispaved =
  or surface=paved|asphalt|concrete|paving_stones|sett
     smoothness=excellent|good

assign is_explicit_unpaved =
  or surface=unpaved|compacted|fine_gravel|gravel|pebblestone|dirt|earth|ground|grass|mud|sand
     smoothness=intermediate|bad|very_bad|horrible|very_horrible|impassable

assign isunpaved =
  if ispaved then false
  else if is_explicit_unpaved then true
  else if surface= then false
  else true

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

# Cycleway: dedicated bike infrastructure (paved only)
assign is_bikelane = if isunpaved then false else ( or highway=cycleway and isresidentialorliving hascycleway )

# Major roads: trunk + primary
assign is_major = or highway=trunk|trunk_link highway=primary|primary_link

# Standard road network (paved, secondary→residential excluded if it's a major)
assign is_road_paved =
  if is_major then false
  else if isunpaved then false
  else if highway=track|path|footway|bridleway|steps then false
  else or highway=secondary|secondary_link
       or highway=tertiary|tertiary_link
       or highway=unclassified|road
       or isresidentialorliving
          highway=service

# Route umbrella: what users intuitively read as "la route".
assign is_route_road =
  if isunpaved then false
  else if is_major then true
  else if is_bikelane then true
  else if is_road_paved then true
  else false

# Singletrack: path / footway / pedestrian / steps without cycleway
assign is_singletrack =
  if is_bikelane then false
  else if highway=path|footway|pedestrian|steps then true
  else false

# Off-road: bridleway + rough tracks (grade 3-5 or dirt/mud/sand/rock)
assign is_offroad =
  if is_bikelane then false
  else if highway=bridleway then true
  else if highway=track then (
    if tracktype=grade3|grade4|grade5 then true
    else if surface=dirt|earth|ground|grass|mud|sand then true
    else false
  )
  else false

# Gravel: unpaved standard roads + tracks (grade 1-2, or untagged tracks) + gravel surfaces
assign is_gravel =
  if is_bikelane then false
  else if is_singletrack then false
  else if is_offroad then false
  else if highway=track then (
    if ispaved then false
    else true
  )
  else if and isunpaved ( or highway=secondary|secondary_link or highway=tertiary|tertiary_link or highway=unclassified|road or isresidentialorliving highway=service ) then true
  else if surface=gravel|fine_gravel|compacted|pebblestone|unpaved then true
  else false

# Per-category factor (1.0 = neutral)
# route now acts as a paved-road umbrella; specific paved-road knobs
# then refine within that family instead of bypassing it entirely.
assign road_surface_factor = if is_route_road then user_factor_road else 1

assign category_surface_factor =
  if is_singletrack then user_factor_singletrack
  else if is_offroad     then user_factor_offroad
  else if is_gravel      then user_factor_gravel
  else if is_bikelane    then user_factor_bikelane
  else if is_major       then user_factor_major
  else 1.0

assign userfactor = multiply road_surface_factor category_surface_factor

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
  else if highway=path|footway|steps then true
  else if highway=bridleway then true
  else if highway=track then
  (
    if tracktype=grade1 then false else true
  )
  else false

assign forest_relief =
  if not consider_forest then 1
  else if estimated_forest_class=6 then ${brfNum(forestReliefByClass[5]!)}
  else if estimated_forest_class=5 then ${brfNum(forestReliefByClass[4]!)}
  else if estimated_forest_class=4 then ${brfNum(forestReliefByClass[3]!)}
  else if estimated_forest_class=3 then ${brfNum(forestReliefByClass[2]!)}
  else if estimated_forest_class=2 then ${brfNum(forestReliefByClass[1]!)}
  else ${brfNum(forestReliefByClass[0]!)}

assign river_relief =
  if not consider_river then 1
  else if estimated_river_class=6 then ${brfNum(riverReliefByClass[5]!)}
  else if estimated_river_class=5 then ${brfNum(riverReliefByClass[4]!)}
  else if estimated_river_class=4 then ${brfNum(riverReliefByClass[3]!)}
  else if estimated_river_class=3 then ${brfNum(riverReliefByClass[2]!)}
  else if estimated_river_class=2 then ${brfNum(riverReliefByClass[1]!)}
  else ${brfNum(riverReliefByClass[0]!)}

# Cities: hard-multiplier applied to ways inside a built-up area
assign in_town =
  if estimated_town_class= then false
  else true

# Settlement road heuristic
assign is_settlement_road =
  if is_bikelane then false
  else if isresidentialorliving then true
  else if highway=service then true
  else if and not isunpaved ( and highway=tertiary|tertiary_link|unclassified estimated_traffic_class=2|3|4|5|6|7 ) then true
  else false

assign settlement_cities_mult =
  if greater user_cities_mult 1 then multiply user_cities_mult 1.35
  else 1

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

assign cities_mult = if in_town then user_cities_mult
                     else if is_settlement_road then settlement_cities_mult
                     else 1

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
  else if ( is_ldcr )                                  then ( if isunpaved then 3.0 else 1 )
  else if ( highway=pedestrian )                       then ( if isbike then ( if hascycleway then 1.1 else 2.2 ) else 3 )
  else if ( highway=bridleway )                        then 5
  else if ( highway=cycleway )                         then ( if isunpaved then 3.0 else 1 )
  else if ( isresidentialorliving )                    then ( if isunpaved then 1.8 else 1.1 )
  else if ( highway=service )                          then ( if isunpaved then 2.2 else 1.3 )
  else if ( highway=track ) then
  (
    if      ( ispaved )          then 1.2
    else if ( tracktype=grade1 ) then ( if probablyGood then 1.3 else 1.8 )
    else if ( tracktype=grade2 ) then ( if probablyGood then 1.8 else 2.5 )
    else if ( tracktype=grade3 ) then ( if probablyGood then 2.5 else 4.0 )
    else if ( tracktype=grade4 ) then ( if probablyGood then 4.0 else 6.0 )
    else if ( tracktype=grade5 ) then 6.0
    else                              3.0
  )
  else if ( highway=path|footway )             then ( if isbike then ( if ispaved then 1.5 else 3.0 ) else 5.0 )
  else if ( highway=trunk|trunk_link )         then ( if isbike then 1.5 else 10  )
  else if ( highway=primary|primary_link )     then ( if isbike then 1.2 else  3  )
  else if ( highway=secondary|secondary_link ) then ( if isbike then 1.1 else 1.6 )
  else if ( highway=tertiary|tertiary_link )   then ( if isbike then 1.0 else 1.4 )
  else if ( highway=unclassified )             then ( if isbike then 1.0 else 1.3 )
  else 2.0

# ─────────────────────────────────────────────────────────────────
# Apply user multiplier — but PRESERVE the 10000 sentinel.
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
`;
}
