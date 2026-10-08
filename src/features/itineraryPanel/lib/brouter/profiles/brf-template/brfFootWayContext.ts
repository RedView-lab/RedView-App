import type { BrfFootValues } from './types';

interface BrfFootWayContextOptions {
  style: BrfFootValues['style'];
  sacLimit: number;
  sacPreferred: number;
  forestReliefByClass: number[];
  riverReliefByClass: number[];
  inClimbMode: boolean;
  brfNum: (v: number, digits?: number) => string;
}

/** Coût de base par mètre de chaque famille de voies, avant les multiplicateurs du panneau. */
interface FootBaseCosts {
  footInfraPaved: number;
  footInfraUnpaved: number;
  pathPaved: number;
  pathStabilized: number;
  pathUnpaved: number;
  steps: number;
  cycleway: number;
  livingStreet: number;
  residential: number;
  service: number;
  trackGood: number;
  trackGrade2: number;
  trackRough: number;
  bridleway: number;
  /** [avec trottoir, sans trottoir] */
  unclassified: [number, number];
  tertiary: [number, number];
  secondary: [number, number];
  primary: [number, number];
  trunk: [number, number];
  unknown: number;
  /** Pénalité additive pour trail_visibility=bad / horrible / no. */
  visibility: [number, number, number];
  /** Pénalité additive pour les sentiers informels (non officiels). */
  informal: number;
  /** Coût de virage (mis à l'échelle par user_turn_factor). */
  turn: number;
}

const FOOT_BASE_COSTS: Record<BrfFootValues['style'], FootBaseCosts> = {
  // Course sur route : revêtements lisses et continus ; trottoirs et voies sans
  // voitures d'abord, routes calmes ensuite, chemins de terre seulement en liaison.
  running: {
    footInfraPaved: 1.0,
    footInfraUnpaved: 1.3,
    pathPaved: 1.0,
    pathStabilized: 1.15,
    pathUnpaved: 1.6,
    steps: 2.0,
    cycleway: 1.1,
    livingStreet: 1.05,
    residential: 1.1,
    service: 1.25,
    trackGood: 1.2,
    trackGrade2: 1.4,
    trackRough: 2.2,
    bridleway: 2.0,
    unclassified: [1.1, 1.4],
    tertiary: [1.15, 1.8],
    secondary: [1.3, 3.0],
    primary: [1.5, 5.0],
    trunk: [2.0, 20],
    unknown: 2.0,
    visibility: [1.0, 3.0, 10000],
    informal: 0.3,
    turn: 15,
  },
  // Trail : singletracks et sentiers de montagne d'abord, pistes ensuite, bitume
  // seulement pour relier des sections de sentier.
  trail: {
    footInfraPaved: 1.3,
    footInfraUnpaved: 1.1,
    pathPaved: 1.2,
    pathStabilized: 1.05,
    pathUnpaved: 1.0,
    steps: 1.3,
    cycleway: 1.4,
    livingStreet: 1.3,
    residential: 1.4,
    service: 1.4,
    trackGood: 1.2,
    trackGrade2: 1.1,
    trackRough: 1.05,
    bridleway: 1.2,
    unclassified: [1.4, 1.6],
    tertiary: [1.6, 2.2],
    secondary: [2.0, 4.0],
    primary: [2.5, 6.0],
    trunk: [3.0, 20],
    unknown: 2.0,
    visibility: [0.3, 1.0, 3.0],
    informal: 0,
    turn: 0,
  },
};

/**
 * Pénalité SAC additive pour les cotations 0..6 (progression de
 * hiking-mountain.brf : ×1,6 par niveau au-dessus de la cotation préférée,
 * interdit au-dessus de la limite). Contrairement à hiking-mountain, les
 * cotations plus faciles sont gratuites : les routes n'ont pas de pénalité SAC,
 * pénaliser les sentiers faciles pousserait donc le tracé sur le bitume.
 */
function buildSacPenalties(limit: number, preferred: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].map((sac) => {
    if (sac > limit) return 10000;
    if (sac <= preferred) return 0;
    return Number((Math.pow(1.6, sac - preferred) - 1).toFixed(4));
  });
}

/**
 * Génère la section ---context:way du profil BRF piéton (Running / Trail).
 *
 * Même contrat que `buildBrfWayContext` (mêmes variables globales
 * user_factor_* / user_* pilotées par le panneau), mais réseau piéton :
 * accès `foot`, trottoirs, sentiers, escaliers, pas de sens unique, et
 * difficulté `sac_scale` (modèle hiking-mountain.brf de BRouter).
 *
 * Correspondance des knobs du panneau :
 *   Route          → routes revêtues sans trottoir
 *   Voies cyclables→ trottoirs & voies piétonnes (footway, pedestrian, path revêtu…)
 *   Gravel         → chemins stabilisés, pistes grade1-2
 *   Singletrack    → sentiers en terre (T1-T2)
 *   Hors-piste     → pistes grade3-5, SAC ≥ T3, sentiers peu visibles
 *   Axes majeurs   → trunk / primary sans trottoir
 */
export function buildBrfFootWayContext({
  style,
  sacLimit,
  sacPreferred,
  forestReliefByClass,
  riverReliefByClass,
  inClimbMode,
  brfNum,
}: BrfFootWayContextOptions): string {
  const c = FOOT_BASE_COSTS[style];
  const sac = buildSacPenalties(sacLimit, sacPreferred);
  const pair = ([withSidewalk, without]: [number, number]) =>
    `( if hassidewalk then ${brfNum(withSidewalk)} else ${brfNum(without)} )`;

  return `---context:way

assign classifier_none  = 1
assign classifier_ferry = 2

# ── Hiking / foot route detection (from hiking-mountain.brf) ──────
assign any_hiking_route =
     if      route_hiking_iwn=yes then true
     else if route_hiking_nwn=yes then true
     else if route_hiking_rwn=yes then true
     else if route_hiking_lwn=yes then true
     else if route_hiking_=yes    then true
     else if route_foot_nwn=yes   then true
     else if route_foot_rwn=yes   then true
     else if route_foot_lwn=yes   then true
     else route_foot_=yes

assign nodeaccessgranted = any_hiking_route

# ── Surface bits ──────────────────────────────────────────────────
assign ispaved =
  or surface=paved|asphalt|concrete|paving_stones|sett|cobblestone
     smoothness=excellent|good

assign is_explicit_unpaved =
  or surface=unpaved|compacted|fine_gravel|gravel|pebblestone|dirt|earth|ground|grass|mud|sand|rock
     smoothness=intermediate|bad|very_bad|horrible|very_horrible|impassable

# Untagged paths / tracks are dirt; untagged streets are tarmac.
assign isunpaved =
  if ispaved then false
  else if is_explicit_unpaved then true
  else if surface= then highway=track|path|bridleway
  else true

assign isstabilized = surface=compacted|fine_gravel|gravel|pebblestone

assign hassidewalk =
  if sidewalk=left|right|both|yes then true
  else if sidewalk:both=yes then true
  else if sidewalk:left=yes|designated then true
  else sidewalk:right=yes|designated

# ── Access (pedestrian) ───────────────────────────────────────────
assign defaultaccess =
       if access= then not motorroad=yes
       else if access=private|no then false
       else true

assign footaccess =
       if foot=no|private|use_sidepath then false
       else if foot=yes|designated|permissive|destination then true
       else if hassidewalk then true
       else if bicycle=dismount then true
       else if highway=motorway|motorway_link|via_ferrata then false
       else defaultaccess

assign accesspenalty =
       if footaccess then 0
       else if foot=use_sidepath then 20
       else if any_hiking_route then 12
       else 10000

# Pedestrians ignore oneway restrictions: no oneway penalty at all.

# ── SAC difficulty (sac_scale, mtb:scale as fallback) ─────────────
assign SAC =
  if sac_scale= then
  (
    if mtb:scale= then 0
    else if mtb:scale=6|5     then 5
    else if mtb:scale=4       then 4
    else if mtb:scale=3       then 3
    else if mtb:scale=2-|2|2+ then 2
    else if mtb:scale=1-|1|1+ then 1
    else 0
  )
  else if sac_scale=difficult_alpine_hiking   then 6
  else if sac_scale=demanding_alpine_hiking   then 5
  else if sac_scale=alpine_hiking             then 4
  else if sac_scale=demanding_mountain_hiking then 3
  else if sac_scale=mountain_hiking           then 2
  else if sac_scale=hiking|T1-hiking|yes      then 1
  else 0

assign is_trailish = highway=path|footway|track|bridleway|steps

assign sac_penalty =
  if not is_trailish then 0
  else if greater SAC sac_scale_limit then 10000
  else if equal SAC 6 then ${brfNum(sac[6]!)}
  else if equal SAC 5 then ${brfNum(sac[5]!)}
  else if equal SAC 4 then ${brfNum(sac[4]!)}
  else if equal SAC 3 then ${brfNum(sac[3]!)}
  else if equal SAC 2 then ${brfNum(sac[2]!)}
  else if equal SAC 1 then ${brfNum(sac[1]!)}
  else ${brfNum(sac[0]!)}

assign visibility_penalty =
  if not is_trailish then 0
  else if trail_visibility=no then ${brfNum(c.visibility[2])}
  else if trail_visibility=horrible then ${brfNum(c.visibility[1])}
  else if trail_visibility=bad then ${brfNum(c.visibility[0])}
  else if informal=yes then ${brfNum(c.informal)}
  else 0

# ── Turn cost (scaled by user_turn_factor) ────────────────────────
assign turncost = if any_hiking_route then 0
                  else multiply ${brfNum(c.turn)} user_turn_factor

assign initialclassifier =
     if route=ferry then classifier_ferry
     else classifier_none

assign initialcost =
     if ( equal initialclassifier classifier_ferry ) then 10000
     else 0

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
# Way category classification (RedView, pedestrian)
# ─────────────────────────────────────────────────────────────────

assign is_major = highway=trunk|trunk_link|primary|primary_link

assign is_street =
  or highway=secondary|secondary_link|tertiary|tertiary_link
  or highway=unclassified|road|residential|service
     is_major

# Hors-piste: rough tracks, bridleways, SAC >= T3, faint trails.
assign is_offroad =
  if highway=bridleway then true
  else if and highway=track tracktype=grade3|grade4|grade5 then true
  else if and is_trailish not highway=steps then
  (
    if greater SAC 2 then true
    else if trail_visibility=bad|horrible|no then true
    else surface=rock|mud|sand
  )
  else false

# Sidewalks & car-free paved ways (knob « Voies cyclables » in bike mode).
assign is_foot_infra =
  if isunpaved then false
  else if highway=footway|pedestrian|living_street|path|steps then true
  else if highway=cycleway then footaccess
  else if is_street then hassidewalk
  else false

# Singletrack: dirt paths and footways.
assign is_singletrack =
  if is_offroad then false
  else if is_foot_infra then false
  else if highway=path|footway|pedestrian then not isstabilized
  else false

# Gravel: stabilised paths, grade1-2 / untagged tracks, unpaved streets.
assign is_gravel =
  if is_offroad then false
  else if is_foot_infra then false
  else if is_singletrack then false
  else if highway=track then not ispaved
  else if highway=path|footway|pedestrian|cycleway then true
  else if is_street then isunpaved
  else false

# Paved roads walked on the carriageway (no sidewalk).
assign is_route_road =
  if isunpaved then false
  else if is_foot_infra then false
  else is_street

assign userfactor =
  if is_route_road then
  (
    if is_major then multiply user_factor_road user_factor_major
    else user_factor_road
  )
  else if is_offroad     then user_factor_offroad
  else if is_singletrack then user_factor_singletrack
  else if is_gravel      then user_factor_gravel
  else if is_foot_infra  then user_factor_bikelane
  else 1.0

# ─────────────────────────────────────────────────────────────────
# Slider-driven extra multipliers (Distance / Durée / Tranquilité).
# ─────────────────────────────────────────────────────────────────

assign is_distance_detour_surface =
  if any_hiking_route then false
  else or is_gravel or is_singletrack is_offroad

# Slow for a runner: dirt, rough ground and steps.
assign is_slow_surface =
  if highway=steps then true
  else or is_singletrack is_offroad

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

assign in_town =
  if estimated_town_class= then false
  else true

assign is_settlement_road = highway=residential|living_street|service

assign settlement_cities_mult =
  if greater user_cities_mult 1 then multiply user_cities_mult 1.35
  else 1

assign is_direct_distance_road =
  if hassidewalk then false
  else or is_major highway=secondary|secondary_link|tertiary|tertiary_link|unclassified

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
assign dur_minor_mult = 1
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

assign hiking_mult = if any_hiking_route then hiking_route_factor else 1

assign slider_multiplier =
  multiply dist_mult
  multiply dur_slow_mult
  multiply dur_fast_mult
  multiply dur_minor_mult
  multiply tranq_mult
  multiply cities_mult
  multiply hiking_mult
          climb_mult

assign combined_factor = multiply userfactor slider_multiplier

# ─────────────────────────────────────────────────────────────────
# basecost — pedestrian cost cascade (${style})
# ─────────────────────────────────────────────────────────────────
assign basecost =
  if ( and highway= not route=ferry )                  then 10000
  else if ( highway=motorway|motorway_link|via_ferrata ) then 10000
  else if ( highway=proposed|abandoned|construction|raceway ) then 10000
  else if ( highway=steps )                            then ( if allow_steps then ${brfNum(c.steps)} else 10000 )
  else if ( route=ferry )                              then ( if allow_ferries then 5.67 else 10000 )
  else if ( highway=footway|pedestrian )               then ( if isunpaved then ( if isstabilized then ${brfNum(c.pathStabilized)} else ${brfNum(c.footInfraUnpaved)} ) else ${brfNum(c.footInfraPaved)} )
  else if ( highway=path )                             then ( if ispaved then ${brfNum(c.pathPaved)} else if isstabilized then ${brfNum(c.pathStabilized)} else ${brfNum(c.pathUnpaved)} )
  else if ( highway=living_street )                    then ${brfNum(c.livingStreet)}
  else if ( highway=cycleway )                         then ${brfNum(c.cycleway)}
  else if ( highway=bridleway )                        then ${brfNum(c.bridleway)}
  else if ( highway=track ) then
  (
    if      ( ispaved )                       then ${brfNum(c.trackGood)}
    else if ( tracktype=grade1 )              then ${brfNum(c.trackGood)}
    else if ( tracktype=grade2 )              then ${brfNum(c.trackGrade2)}
    else if ( tracktype=grade3|grade4|grade5 ) then ${brfNum(c.trackRough)}
    else                                           ${brfNum(c.trackGrade2)}
  )
  else if ( highway=residential )                      then ( if hassidewalk then ${brfNum(c.livingStreet)} else ${brfNum(c.residential)} )
  else if ( highway=service )                          then ${brfNum(c.service)}
  else if ( highway=unclassified|road )                then ${pair(c.unclassified)}
  else if ( highway=tertiary|tertiary_link )           then ${pair(c.tertiary)}
  else if ( highway=secondary|secondary_link )         then ${pair(c.secondary)}
  else if ( highway=primary|primary_link )             then ${pair(c.primary)}
  else if ( highway=trunk|trunk_link )                 then ${pair(c.trunk)}
  else ${brfNum(c.unknown)}

# Terrain difficulty on top of the base cost (keeps the 10000 sentinel).
assign terraincost =
  if greater basecost 9999 then 10000
  else if greater sac_penalty 9999 then 10000
  else if greater visibility_penalty 9999 then 10000
  else add basecost add sac_penalty visibility_penalty

# ─────────────────────────────────────────────────────────────────
# Apply user multiplier — but PRESERVE the 10000 sentinel.
# ─────────────────────────────────────────────────────────────────
assign weightedbase =
  if greater terraincost 9999 then 10000
  else if shortest_mode then
  (
    if greater ( multiply userfactor 1 ) 9999 then 9999
    else multiply userfactor 1
  )
  else if greater ( multiply combined_factor terraincost ) 9999 then 9999
  else multiply combined_factor terraincost

# ─────────────────────────────────────────────────────────────────
# Final costfactor: weightedbase + access + soft penalties.
# ─────────────────────────────────────────────────────────────────
assign costfactor
  add accesspenalty
  add town_penalty
  add traffic_penalty
  add noise_penalty
      weightedbase

${inClimbMode ? `# ─── Climbing-mode: cheaper climbs, same surface ranking ──────────
# BRouter blends uphillcostfactor in place of costfactor on climbs, so a
# flat per-category value would make uphill tarmac as cheap as a trail.
assign uphillcostfactor =
  if greater costfactor 9998 then costfactor
  else multiply costfactor 0.7
` : ''}
# Voice-hint priority (from hiking-mountain.brf)
assign priorityclassifier =
  if      ( highway=motorway                  ) then  30
  else if ( highway=motorway_link             ) then  29
  else if ( highway=trunk                     ) then  28
  else if ( highway=trunk_link                ) then  27
  else if ( highway=primary                   ) then  26
  else if ( highway=primary_link              ) then  25
  else if ( highway=secondary                 ) then  24
  else if ( highway=secondary_link            ) then  23
  else if ( highway=tertiary                  ) then  22
  else if ( highway=tertiary_link             ) then  21
  else if ( highway=unclassified              ) then  20
  else if ( highway=residential|living_street ) then  18
  else if ( highway=steps|pedestrian          ) then  16
  else if ( highway=service|cycleway          ) then  if ( or tracktype=grade1 ispaved ) then 14 else 12
  else if ( highway=track|road|bridleway      ) then  if ( or tracktype=grade1 ispaved ) then 10 else 8
  else if ( highway=path|footway              ) then
  (
    if ( or tracktype=grade1 ispaved ) then 6
    else if tracktype=grade2 then 4
    else if not surface=grass|gravel then 3
    else 2
  )
  else 0

assign isbadoneway  = false
assign isgoodoneway = false
assign isroundabout = junction=roundabout
assign islinktype   = highway=motorway_link|trunk_link|primary_link|secondary_link|tertiary_link
assign isgoodforcars = if greater priorityclassifier 19 then true
                  else if highway=residential|living_street|service then true
                  else if ( and highway=track tracktype=grade1 ) then true
                  else false

assign classifiermask add          isbadoneway
                      add multiply isgoodoneway   2
                      add multiply isroundabout   4
                      add multiply islinktype     8
                          multiply isgoodforcars 16
`;
}
