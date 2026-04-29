import { ALL_PARAMETERS } from '../../../expert/parameters';
import type { ExpertProfileState } from '../../../expert/types';
import type { RoadPreference, RoadTypesState } from '../../../types';
import type { BrfBuildInputs, BrfProfileValues } from './types';

function prefToFactor(preference: RoadPreference): number {
  switch (preference) {
    case 'prefer':
      return 1.0;
    case 'tolerate':
      return 1.0;
    case 'avoid':
      return 4.0;
    case 'forbid':
      return 50;
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

  const categories: Array<keyof Pick<
    RoadTypesState,
    'road' | 'gravel' | 'singletrack' | 'offroad' | 'bikeLanes' | 'majorRoads'
  >> = ['road', 'gravel', 'singletrack', 'offroad', 'bikeLanes', 'majorRoads'];
  const anyPrefer = categories.some((category) => roadTypes[category] === 'prefer');
  const factorFor = (preference: RoadPreference): number => {
    if (preference === 'tolerate' && anyPrefer) return 1.5;
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

  const sign = (value: number): number =>
    Math.max(-1, Math.min(1, (Math.max(0, Math.min(100, value)) - 50) / 50));

  const sElev = sign(priorities.elevation);
  const sDist = sign(priorities.distance);
  const sDur = sign(priorities.duration);
  const sTranq = sign(priorities.tranquility);

  let upCost: number;
  let downCost: number;
  let upCutoff: number;
  let downCutoff: number;
  let elevPenaltyBuffer: number;
  let elevMaxBuffer: number;
  let elevBufferReduce: number;
  let climbMul = 1.0;

  if (sElev <= 0) {
    upCost = Math.round(60 + (-sElev) * 240);
    downCost = 0;
    upCutoff = 1.5;
    downCutoff = 1.5;
    elevPenaltyBuffer = 10;
    elevMaxBuffer = 20;
    elevBufferReduce = 0;
  } else if (sElev <= 0.4) {
    upCost = Math.round(60 * (1 - sElev * 0.7));
    downCost = 60;
    upCutoff = 1.5;
    downCutoff = 1.5;
    elevPenaltyBuffer = 10;
    elevMaxBuffer = 20;
    elevBufferReduce = 0;
  } else {
    const climbScale = (sElev - 0.4) / 0.6;
    upCost = 0;
    downCost = 0;
    upCutoff = 1.5 - climbScale * 1.2;
    downCutoff = 1.5 - climbScale * 1.2;
    elevPenaltyBuffer = 1;
    elevMaxBuffer = 2;
    elevBufferReduce = 1.05;
    climbMul = 1.0 + climbScale * 4.0;
  }

  const considerElevation = true;
  const inClimbMode = sElev > 0.4;
  const pass1Coefficient = inClimbMode ? 1.8 : 1.5;

  const maxSlope = Math.min(99, Math.max(1, roadTypes.maxSlopePercent || 99));
  const maxSlopeCost = maxSlope >= 99 ? 0 : 500;

  const turnFactor = (() => {
    switch (roadTypes.turns) {
      case 'prefer':
        return 0.3;
      case 'tolerate':
        return 1.0;
      case 'avoid':
        return 4.0;
      case 'forbid':
        return 50.0;
    }
    return 1.0;
  })();

  const ignoreCycleroutes = sDist <= -0.4 || sDur >= 0.4;
  const distNonCyclePenalty = sDist > 0 ? 1 + sDist * 1.0 : 1;
  const durSlowPenalty = sDur > 0 ? 1 + sDur * 0.4 : 1;
  const durFastPenalty = sDur < 0 ? 1 + -sDur * 0.4 : 1;
  const durMinorPenalty = sDur > 0 ? 1 + sDur * 0.2 : 1;

  const tranqConsiderNoise = sTranq >= 0.4;
  const tranqStickToCycleroutes = sTranq >= 0.6;
  const considerTraffic = sTranq >= 0.2;
  const avoidUnsafe = sTranq >= 0.2;
  const tranqMajorPenalty = sTranq > 0 ? 1 + sTranq * 3.0 : 1;
  const citiesMult =
    roadTypes.cities === 'forbid' ? 50.0
      : roadTypes.cities === 'avoid' ? 6.0
        : sTranq >= 0.6 ? 2.5
          : 1.0;
  const considerTown =
    roadTypes.cities === 'avoid' ||
    roadTypes.cities === 'forbid' ||
    sTranq >= 0.2;

  const totalMass = expertValue(expert, 'totalMass', defaultFor('totalMass') as number);
  const maxSpeed = expertValue(expert, 'maxSpeed', defaultFor('maxSpeed') as number);
  const sCx = expertValue(expert, 'S_C_x', defaultFor('S_C_x') as number);
  const cR = expertValue(expert, 'C_r', defaultFor('C_r') as number);
  const bikerPower = expertValue(expert, 'bikerPower', defaultFor('bikerPower') as number);
  const stickToCycleRoutes = expertValue(expert, 'stick_to_cycleroutes', false) || tranqStickToCycleroutes;
  const useProposedCycleRoutes = expertValue(expert, 'use_proposed_cycleroutes', false);
  const considerNoise = expertValue(expert, 'consider_noise', false) || tranqConsiderNoise;
  const considerRiver = expertValue(expert, 'consider_river', false);
  const considerForest = expertValue(expert, 'consider_forest', false);
  const turnInstructionMode = expertValue(expert, 'turnInstructionMode', 1);
  const considerTurnRestrictions = expertValue(expert, 'considerTurnRestrictions', true);

  return {
    fRoad,
    fGravel,
    fSingletrack,
    fOffroad,
    fBikelane,
    fMajor,
    allowFerries,
    allowSteps,
    turnFactor,
    distNonCyclePenalty,
    durSlowPenalty,
    durFastPenalty,
    durMinorPenalty,
    tranqMajorPenalty,
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
  };
}