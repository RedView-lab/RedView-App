import { ALL_PARAMETERS } from '../../../../expert/parameters';
import type { ExpertProfileState } from '../../../../expert/types';
import type { RoadPreference, RoadTypesState } from '../../../../types';
import { isFootDiscipline } from '@/shared/lib/discipline';
import type { BrfBuildInputs, BrfFootValues, BrfProfileValues } from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildReliefByClass(maxPenalty: number): [number, number, number, number, number, number] {
  const weights = [1, 0.84, 0.66, 0.45, 0.22, 0] as const;
  return weights.map((weight) => Number((1 + ((maxPenalty - 1) * weight)).toFixed(4))) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
}

function buildBonusByClass(
  backgroundPenalty: number,
  strongestBonus: number,
): [number, number, number, number, number, number] {
  const weights = [0, 0.12, 0.28, 0.48, 0.72, 1] as const;
  return weights.map((weight) => Number((backgroundPenalty + ((strongestBonus - backgroundPenalty) * weight)).toFixed(4))) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
}

function prefToFactor(preference: RoadPreference): number {
  switch (preference) {
    case 'prefer':
      return 0.9;
    case 'tolerate':
      return 1.0;
    case 'avoid':
      return 1.15;
    case 'forbid':
      return 2.5;
  }
  return 1.0;
}

/**
 * SAC ceilings per tracing mode (sac_scale T1 = 1 … T6 = 6). Road running
 * stays on T1 at most; trail goes up to T3 (T4 in Aventure: alpine paths,
 * hands occasionally needed), T5+ is never runnable.
 */
function resolveFootValues(
  style: BrfFootValues['style'],
  tracingMode: RoadTypesState['tracingMode'],
): BrfFootValues {
  if (style === 'running') {
    const adventurous = tracingMode === 'aventure';
    return {
      style,
      sacLimit: adventurous ? 2 : 1,
      sacPreferred: adventurous ? 1 : 0,
      hikingRouteFactor: 1,
    };
  }
  switch (tracingMode) {
    case 'comfort':
      return { style, sacLimit: 2, sacPreferred: 1, hikingRouteFactor: 0.9 };
    case 'aventure':
      return { style, sacLimit: 4, sacPreferred: 3, hikingRouteFactor: 0.85 };
    default:
      return { style, sacLimit: 3, sacPreferred: 2, hikingRouteFactor: 0.9 };
  }
}

function expertValue<T>(
  expert: ExpertProfileState | null | undefined,
  id: string,
  fallback: T,
): T {
  if (!expert || !expert.enabled) return fallback;
  const value = expert.values[id];
  if (value === undefined || value === null) return fallback;
  return value as T;
}

function defaultFor(id: string): unknown {
  const parameter = ALL_PARAMETERS.find((entry: { id: string; default: unknown }) => entry.id === id);
  return parameter?.default;
}

export function resolveBrfProfileValues(inputs: BrfBuildInputs): BrfProfileValues {
  const { priorities, roadTypes, expert, discipline } = inputs;
  const foot = isFootDiscipline(discipline)
    ? resolveFootValues(discipline, roadTypes.tracingMode)
    : null;

  const factorFor = (preference: RoadPreference): number => {
    return prefToFactor(preference);
  };

  const fRoad = factorFor(roadTypes.road);
  const fGravel = factorFor(roadTypes.gravel);
  const fSingletrack = factorFor(roadTypes.singletrack);
  const fOffroad = factorFor(roadTypes.offroad);
  const fBikelane = factorFor(roadTypes.bikeLanes);
  const fMajor = factorFor(roadTypes.majorRoads);
  const allowFerries = roadTypes.ferry !== 'forbid';
  // Steps are part of the pedestrian network; the way context prices them.
  const allowSteps = foot != null || (roadTypes.bikeLanes !== 'forbid' && fSingletrack < 10000);

  // Surface preferences scaling with tolerance (0% strict ~2.0, 10% default ~1.5, 100% max tolerance ~0.15)
  const tol = clamp(roadTypes.surfaceTolerance ?? 10, 0, 100);
  const tolFactor = tol <= 10
    ? 2.0 - (tol / 10) * 0.5
    : Math.max(0.15, 1.5 - ((tol - 10) / 90) * 1.35);
  let effectiveFRoad = fRoad;
  let effectiveFGravel = fGravel;
  let effectiveFSingletrack = fSingletrack;
  let effectiveFOffroad = fOffroad;

  const surfaceOrder = ['tarmac', 'paved', 'gravel', 'other'];
  const surfaceMin = roadTypes.surfaceMin ?? 'tarmac';
  const surfaceMax = roadTypes.surfaceMax ?? roadTypes.surfacePreference ?? 'gravel';
  const minIdx = Math.max(0, surfaceOrder.indexOf(surfaceMin));
  const maxIdx = Math.max(minIdx, surfaceOrder.indexOf(surfaceMax));

  // If minIdx === maxIdx (superposition: strictly single surface prioritized absolutely)
  if (minIdx === maxIdx) {
    switch (surfaceMin) {
      case 'tarmac':
        effectiveFRoad = Math.min(effectiveFRoad, 0.75);
        effectiveFGravel = Math.max(effectiveFGravel, 3.0 * tolFactor);
        effectiveFSingletrack = Math.max(effectiveFSingletrack, 3.5 * tolFactor);
        effectiveFOffroad = Math.max(effectiveFOffroad, 4.0 * tolFactor);
        break;
      case 'paved':
        effectiveFRoad = Math.max(effectiveFRoad, 2.0 * tolFactor);
        effectiveFGravel = Math.max(effectiveFGravel, 3.0 * tolFactor);
        effectiveFSingletrack = Math.max(effectiveFSingletrack, 3.5 * tolFactor);
        effectiveFOffroad = Math.max(effectiveFOffroad, 4.0 * tolFactor);
        break;
      case 'gravel':
        effectiveFGravel = Math.min(effectiveFGravel, 0.75);
        effectiveFRoad = Math.max(effectiveFRoad, 3.0 * tolFactor);
        effectiveFSingletrack = Math.max(effectiveFSingletrack, 3.0 * tolFactor);
        effectiveFOffroad = Math.max(effectiveFOffroad, 3.5 * tolFactor);
        break;
      case 'other':
        effectiveFSingletrack = Math.min(effectiveFSingletrack, 0.75);
        effectiveFOffroad = Math.min(effectiveFOffroad, 0.85);
        effectiveFGravel = Math.max(effectiveFGravel, 2.5 * tolFactor);
        effectiveFRoad = Math.max(effectiveFRoad, 3.5 * tolFactor);
        break;
    }
  } else {
    // Range of surfaces. A surface inside the range is pulled towards
    // « preferred » only when the user tolerates or prefers it: « Éviter » /
    // « Interdire » stay as chosen (the range used to lower a gravel preset's
    // « Éviter la route » 1.15 to 0.9, below its gravel factor).
    const included = (preference: RoadPreference, factor: number, cap: number): number =>
      preference === 'avoid' || preference === 'forbid' ? factor : Math.min(factor, cap);

    // If tarmac (0) excluded
    if (minIdx > 0) {
      effectiveFRoad = Math.max(effectiveFRoad, 2.5 * tolFactor);
    } else {
      effectiveFRoad = included(roadTypes.road, effectiveFRoad, 0.9);
    }

    // Gravel (2)
    if (maxIdx < 2) {
      effectiveFGravel = Math.max(effectiveFGravel, 2.5 * tolFactor);
    } else if (minIdx <= 2 && maxIdx >= 2) {
      // Track base costs (trekking heritage: grade2 2.5, untagged 3.0) outweigh
      // a ×0.85 preference against a small road (1.0–1.4): « Privilégier » the
      // gravel must compensate, or a Gravel preset rides 90–97 % tarmac.
      effectiveFGravel = roadTypes.gravel === 'prefer'
        ? Math.min(effectiveFGravel, 0.6)
        : included(roadTypes.gravel, effectiveFGravel, 0.85);
    }

    // Other (3: singletrack & offroad)
    if (maxIdx < 3) {
      effectiveFSingletrack = Math.max(effectiveFSingletrack, 2.8 * tolFactor);
      effectiveFOffroad = Math.max(effectiveFOffroad, 3.2 * tolFactor);
    } else {
      effectiveFSingletrack = included(roadTypes.singletrack, effectiveFSingletrack, 0.85);
      effectiveFOffroad = included(roadTypes.offroad, effectiveFOffroad, 0.95);
    }
  }

  const sign = (value: number): number =>
    Math.max(-1, Math.min(1, (Math.max(0, Math.min(100, value)) - 50) / 50));

  const sElev = sign(priorities.elevation);
  const sDist = sign(priorities.distance);
  const sDur = sign(priorities.duration);
  const sTranq = sign(priorities.tranquility);

  // On foot, « Dénivelé : Privilégier » is the runner's max-D+ control: give
  // it the full climbing mode of the max elevation priority, not just free climbs.
  const climbFocus = foot && roadTypes.elevationPreference === 'prefer'
    ? 1
    : Math.max(0, sElev);
  const climbAvoid = Math.max(0, -sElev);
  // Priorité « Distance » des presets : haute = au plus direct (Vitesse 55–70),
  // basse = détours acceptés (Aventure / Confort 35–45). L'ancien code lisait
  // l'inverse : Vitesse pénalisait les routes directes (×1.5) et allégeait les
  // chemins, à l'opposé du commentaire de `is_distance_detour_surface`.
  const directnessFocus = Math.max(0, sDist);
  const detourAppetite = Math.max(0, -sDist);
  const durationFocus = Math.max(0, sDur);
  const durationRelax = Math.max(0, -sDur);
  const tranquilityFocus = Math.max(0, sTranq);

  let upCost: number;
  let downCost: number;
  let upCutoff: number;
  let downCutoff: number;
  let elevPenaltyBuffer: number;
  let elevMaxBuffer: number;
  let elevBufferReduce: number;
  let climbMul = 1.0;

  if (climbFocus <= 0.15) {
    // Standard BRouter trekking baseline: no uphill penalty in neutral mode so mountains/valleys don't explode search
    upCost = climbAvoid > 0.1 ? Math.round(climbAvoid * 80) : 0;
    downCost = 60;
    upCutoff = 1.5;
    downCutoff = 1.5;
    elevPenaltyBuffer = 8;
    elevMaxBuffer = 16;
    elevBufferReduce = 0.25;
  } else {
    const climbScale = clamp((climbFocus - 0.15) / 0.85, 0, 1);
    upCost = Math.round(20 * (1 - climbScale));
    downCost = 0;
    upCutoff = 1.5 + (climbScale * 1.5);
    downCutoff = 1.5 + (climbScale * 1.0);
    elevPenaltyBuffer = 8 - (climbScale * 7.25);
    elevMaxBuffer = 16 - (climbScale * 14.5);
    elevBufferReduce = 0.35 + (climbScale * 1.4);
    climbMul = 1.0 + (climbScale * (detourAppetite > 0.7 ? 3.0 : 2.0));
  }

  // Factor in explicit elevationPreference if chosen in panel
  if (roadTypes.elevationPreference) {
    switch (roadTypes.elevationPreference) {
      case 'avoid':
        upCost = Math.max(upCost, 80);
        downCost = Math.max(downCost, 60);
        climbMul = 1.0;
        break;
      case 'forbid':
        upCost = Math.max(upCost, 140);
        downCost = Math.max(downCost, 90);
        climbMul = 1.0;
        break;
      case 'prefer':
        upCost = 0;
        downCost = 0;
        climbMul = Math.max(climbMul, 1.6);
        break;
      case 'tolerate':
        upCost = Math.min(upCost, 30);
        break;
    }
  }

  upCutoff = clamp(upCutoff, 0.8, 3.0);
  downCutoff = clamp(downCutoff, 1.0, 2.5);
  elevPenaltyBuffer = clamp(elevPenaltyBuffer, 0.75, 10);
  elevMaxBuffer = clamp(elevMaxBuffer, 1.5, 20);
  elevBufferReduce = clamp(elevBufferReduce, 0, 2.0);

  const considerElevation = true;
  const inClimbMode = climbFocus > 0.25 || roadTypes.elevationPreference === 'prefer';
  const shortestMode = directnessFocus >= 0.65 && climbFocus < 0.2 && durationFocus < 0.4;
  
  // Passe unique (pass2=-1). Le coefficient A* réel est fixé à chaque requête
  // (lib/brouter/api/searchCoefficient.ts) ; la valeur du profil n'est qu'un défaut.
  const pass1Coefficient = 3.5;
  const pass2Coefficient = -1;

  const maxSlope = Math.min(99, Math.max(1, roadTypes.maxSlopePercent || 99));
  const maxSlopeCost = maxSlope < 90 ? 80 : 0;

  const baseTurnFactor = (() => {
    switch (roadTypes.turns) {
      case 'prefer':
        return 0.8;
      case 'tolerate':
        return 1.0;
      case 'avoid':
        return 1.1;
      case 'forbid':
        return 1.4;
    }
    return 1.0;
  })();

  let turnFactor = baseTurnFactor * (1 + (durationFocus * 0.3) + (directnessFocus * 0.2));

  const ignoreCycleroutes = detourAppetite >= 0.75 || directnessFocus >= 0.75 || durationFocus >= 0.85;
  let distDetourRelief = detourAppetite > 0
    ? (inClimbMode
        ? clamp(1 - (detourAppetite * 0.3), 0.7, 1)
        : clamp(1 - (detourAppetite * 0.2), 0.8, 1))
    : 1 + (directnessFocus * 0.5);
  const distDirectPenalty = 1 + (detourAppetite * (inClimbMode ? 1.4 : 1.2));
  let durSlowPenalty = 1 + (durationFocus * 0.6);
  const durFastPenalty = durationRelax > 0 ? 1 + (durationRelax * 0.2) : 1;
  const durMinorPenalty = 1 + (durationFocus * 0.4);
  let signalPenalty = Math.round(10 + (durationFocus * 40) + (tranquilityFocus * 20));

  const tranqConsiderNoise = false;
  const tranqStickToCycleroutes = tranquilityFocus >= 0.85;
  let considerTraffic = false;
  let avoidUnsafe = false;
  let tranqMajorPenalty = 1 + (tranquilityFocus * 0.3);
  let tranqFastTrafficPenalty = 1 + (tranquilityFocus * 0.4);
  const tranqBackgroundPenalty = 1.0;
  const citiesMult =
    roadTypes.cities === 'forbid' ? 1.5
      : roadTypes.cities === 'avoid' ? 1.2
        : 1.0;
  const considerTown = false;
  const townPenaltyScale = 1.0;
  const trafficPenaltyScale = 1.0;

  // Woods relief (protection vent et soleil)
  const forestReliefByClass =
    roadTypes.woods === 'prefer'
      ? buildBonusByClass(1.4, 0.5)
      : roadTypes.woods === 'avoid'
        ? buildReliefByClass(1.3)
        : roadTypes.woods === 'forbid'
          ? buildReliefByClass(2.0)
          : tranquilityFocus > 0
            ? buildBonusByClass(1 + (tranquilityFocus * 0.6), clamp(1 - (tranquilityFocus * 0.4), 0.5, 1))
            : buildReliefByClass(1);

  const riverReliefByClass = tranquilityFocus > 0
    ? buildBonusByClass(1 + (tranquilityFocus * 0.5), clamp(1 - (tranquilityFocus * 0.4), 0.5, 1))
    : buildReliefByClass(1);

  // Foot: BRouter times walking/running with Tobler's function
  // (maxSpeed · e^(-3.5·|slope + 5 %|) ≈ 0.84 · maxSpeed on the flat); the
  // bike kinematic knobs below are ignored by the engine in foot mode.
  const totalMass = foot ? 70 : expertValue(expert, 'totalMass', defaultFor('totalMass') as number);
  const maxSpeedBase = foot
    ? foot.style === 'running' ? 13 : 10
    : expertValue(expert, 'maxSpeed', defaultFor('maxSpeed') as number);
  const sCx = expertValue(expert, 'S_C_x', defaultFor('S_C_x') as number);
  const cR = expertValue(expert, 'C_r', defaultFor('C_r') as number);
  const bikerPowerBase = expertValue(expert, 'bikerPower', defaultFor('bikerPower') as number);
  let maxSpeed = maxSpeedBase * clamp(1 + (durationFocus * 0.1) - (durationRelax * 0.05), 0.85, 1.12);
  const bikerPower = bikerPowerBase * clamp(1 + (durationFocus * 0.16) - (durationRelax * 0.08), 0.8, 1.22);
  let stickToCycleRoutes = expertValue(expert, 'stick_to_cycleroutes', false) || tranqStickToCycleroutes;
  const useProposedCycleRoutes = expertValue(expert, 'use_proposed_cycleroutes', false);
  const considerNoise = expertValue(expert, 'consider_noise', false) || tranqConsiderNoise;
  let considerRiver = expertValue(expert, 'consider_river', false) || tranquilityFocus >= 0.45;
  const considerForest =
    expertValue(expert, 'consider_forest', false) ||
    roadTypes.woods === 'prefer' ||
    (roadTypes.woods !== 'forbid' && tranquilityFocus >= 0.45);
  const turnInstructionMode = expertValue(expert, 'turnInstructionMode', 1);
  // Turn restrictions only bind vehicles.
  const considerTurnRestrictions = foot ? false : expertValue(expert, 'considerTurnRestrictions', true);

  // Apply tracingMode adjustments
  if (roadTypes.tracingMode === 'vitesse') {
    turnFactor *= 1.25;
    signalPenalty = Math.max(signalPenalty, 40);
    durSlowPenalty = Math.max(durSlowPenalty, 1.7);
    maxSpeed *= 1.1;
  } else if (roadTypes.tracingMode === 'aventure') {
    considerRiver = true;
    distDetourRelief = Math.min(distDetourRelief, 0.7);
    tranqMajorPenalty = Math.max(tranqMajorPenalty, 1.5);
  } else if (roadTypes.tracingMode === 'comfort') {
    stickToCycleRoutes = true;
    considerTraffic = true;
    avoidUnsafe = true;
    tranqFastTrafficPenalty = Math.max(tranqFastTrafficPenalty, 1.6);
  }

  // Gravel : le chemin carrossable est la surface même du preset, y compris en
  // Vitesse (×1,7 « surface lente » donnait 3 % de non-revêtu sur un preset Gravel).
  if (roadTypes.activityType === 'gravel-default') {
    durSlowPenalty = Math.min(durSlowPenalty, 1.2);
  }

  return {
    fRoad: effectiveFRoad,
    fGravel: effectiveFGravel,
    fSingletrack: effectiveFSingletrack,
    fOffroad: effectiveFOffroad,
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
    pass2Coefficient,
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
    foot,
  };
}

/**
 * Coût BRouter « brut » au mètre du réseau qu'un tracé emprunte avec ce profil :
 * surtout le réseau le moins cher (petite route, chemin carrossable ou sentier,
 * à plat, hors agglomération), un peu de routes de liaison, multiplicateurs
 * « tranquillité » de fond et de grimpe compris (ce dernier atténué : les
 * montées en mode grimpe coûtent moins cher).
 */
export function searchCostNetwork(values: BrfProfileValues): number {
  const tranquil =
    (values.considerForest ? values.forestReliefByClass[0] : 1) *
    (values.considerRiver ? values.riverReliefByClass[0] : 1);
  const climb = values.inClimbMode ? 1 + (values.climbMul - 1) * 0.45 : values.climbMul;
  if (values.foot) {
    return 1.1 * Math.min(values.fRoad, values.fGravel, values.fSingletrack, values.fBikelane) * tranquil * climb;
  }
  const offroadMult = values.distDetourRelief * values.durSlowPenalty;
  const road = 1.3 * values.fRoad * values.distDirectPenalty;
  const cheapest = Math.min(road, 1.8 * values.fGravel * offroadMult, 3.0 * values.fSingletrack * offroadMult);
  return (0.8 * cheapest + 0.2 * road) * tranquil * climb;
}

/**
 * Coût BRouter typique au mètre d'un tracé avec ce profil (réseau + surcoûts
 * moyens de dénivelé et de virages) : cale le coefficient A* avant que le coût
 * réel n'ait été observé (lib/brouter/api/searchCoefficient.ts). Constantes
 * ajustées sur script-test-bench/routing-quality (coûts mesurés).
 */
export function estimateSearchCostScale(values: BrfProfileValues): number {
  const scale = SEARCH_SCALE_A * searchCostNetwork(values) + SEARCH_SCALE_B;
  return Math.round(Math.max(0.8, Math.min(8, scale)) * 100) / 100;
}

const SEARCH_SCALE_A = 0.88;
const SEARCH_SCALE_B = 0.7;
