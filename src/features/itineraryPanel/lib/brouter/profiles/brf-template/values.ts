import { ALL_PARAMETERS } from '../../../../expert/parameters';
import type { ExpertProfileState } from '../../../../expert/types';
import type { RoadPreference } from '../../../../types';
import type { BrfBuildInputs, BrfProfileValues } from './types';

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
  const { priorities, roadTypes, expert } = inputs;

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
  const allowSteps = roadTypes.bikeLanes !== 'forbid' && fSingletrack < 10000;

  // Surface preferences scaling with tolerance
  const tolFactor = clamp(1 + ((20 - (roadTypes.surfaceTolerance ?? 10)) / 20), 0.7, 1.8);
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
    // Range of surfaces:
    // If tarmac (0) excluded
    if (minIdx > 0) {
      effectiveFRoad = Math.max(effectiveFRoad, 2.5 * tolFactor);
    } else {
      effectiveFRoad = Math.min(effectiveFRoad, 0.9);
    }

    // Gravel (2)
    if (maxIdx < 2) {
      effectiveFGravel = Math.max(effectiveFGravel, 2.5 * tolFactor);
    } else if (minIdx <= 2 && maxIdx >= 2) {
      effectiveFGravel = Math.min(effectiveFGravel, 0.85);
    }

    // Other (3: singletrack & offroad)
    if (maxIdx < 3) {
      effectiveFSingletrack = Math.max(effectiveFSingletrack, 2.8 * tolFactor);
      effectiveFOffroad = Math.max(effectiveFOffroad, 3.2 * tolFactor);
    } else {
      effectiveFSingletrack = Math.min(effectiveFSingletrack, 0.85);
      effectiveFOffroad = Math.min(effectiveFOffroad, 0.95);
    }
  }

  const sign = (value: number): number =>
    Math.max(-1, Math.min(1, (Math.max(0, Math.min(100, value)) - 50) / 50));

  const sElev = sign(priorities.elevation);
  const sDist = sign(priorities.distance);
  const sDur = sign(priorities.duration);
  const sTranq = sign(priorities.tranquility);

  const climbFocus = Math.max(0, sElev);
  const climbAvoid = Math.max(0, -sElev);
  const distanceFocus = Math.max(0, sDist);
  const distanceDetourAllowance = Math.max(0, -sDist);
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
    climbMul = 1.0 + (climbScale * (distanceFocus > 0.7 ? 3.0 : 2.0));
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
  const shortestMode = distanceDetourAllowance >= 0.65 && climbFocus < 0.2 && durationFocus < 0.4;
  
  // Ultra-fast One-Pass BRouter mode: pass1=3.5 directs A* linearly to destination, pass2=-1 disables quadratic 2nd pass
  let pass1Coefficient = 3.5;
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

  let turnFactor = baseTurnFactor * (1 + (durationFocus * 0.3) + (distanceDetourAllowance * 0.2));

  const ignoreCycleroutes = distanceFocus >= 0.75 || distanceDetourAllowance >= 0.75 || durationFocus >= 0.85;
  let distDetourRelief = distanceFocus > 0
    ? (inClimbMode
        ? clamp(1 - (distanceFocus * 0.3), 0.7, 1)
        : clamp(1 - (distanceFocus * 0.2), 0.8, 1))
    : 1 + (distanceDetourAllowance * 0.5);
  const distDirectPenalty = 1 + (distanceFocus * (inClimbMode ? 1.4 : 1.2));
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

  const totalMass = expertValue(expert, 'totalMass', defaultFor('totalMass') as number);
  const maxSpeedBase = expertValue(expert, 'maxSpeed', defaultFor('maxSpeed') as number);
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
  const considerTurnRestrictions = expertValue(expert, 'considerTurnRestrictions', true);

  // Apply tracingMode adjustments
  if (roadTypes.tracingMode === 'vitesse') {
    turnFactor *= 1.25;
    signalPenalty = Math.max(signalPenalty, 40);
    durSlowPenalty = Math.max(durSlowPenalty, 1.7);
    maxSpeed *= 1.1;
    pass1Coefficient = 4.0;
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
  };
}