import { ALL_PARAMETERS } from '../../../../expert/parameters';
import type { ExpertProfileState } from '../../../../expert/types';
import type { RoadPreference, RoadTypesState } from '../../../../types';
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
    upCost = Math.round(60 + (climbAvoid * 220));
    downCost = Math.round(40 + (climbAvoid * 50));
    upCutoff = 1.5 - (climbAvoid * 0.5);
    downCutoff = 1.5 - (climbAvoid * 0.2);
    elevPenaltyBuffer = 8 - (climbAvoid * 2);
    elevMaxBuffer = 16 - (climbAvoid * 4);
    elevBufferReduce = 0.25 + (climbAvoid * 0.35);
  } else {
    const climbScale = clamp((climbFocus - 0.15) / 0.85, 0, 1);
    upCost = Math.round(40 * (1 - climbScale));
    downCost = 0;
    upCutoff = 1.5 + (climbScale * 1.5);
    downCutoff = 1.5 + (climbScale * 1.0);
    elevPenaltyBuffer = 8 - (climbScale * 7.25);
    elevMaxBuffer = 16 - (climbScale * 14.5);
    elevBufferReduce = 0.35 + (climbScale * 1.4);
    climbMul = 1.0 + (climbScale * (distanceFocus > 0.7 ? 16.0 : 14.0));
  }

  upCutoff = clamp(upCutoff, 0.8, 3.0);
  downCutoff = clamp(downCutoff, 1.0, 2.5);
  elevPenaltyBuffer = clamp(elevPenaltyBuffer, 0.75, 10);
  elevMaxBuffer = clamp(elevMaxBuffer, 1.5, 20);
  elevBufferReduce = clamp(elevBufferReduce, 0, 2.0);

  const considerElevation = true;
  const inClimbMode = climbFocus > 0.25;
  const shortestMode = distanceDetourAllowance >= 0.65 && climbFocus < 0.2 && durationFocus < 0.4;
  const pass1Coefficient = inClimbMode ? 1.5 : 1.5;

  const maxSlope = Math.min(99, Math.max(1, roadTypes.maxSlopePercent || 99));
  const maxSlopeCost = maxSlope >= 99 ? 0 : 500;

  const baseTurnFactor = (() => {
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

  const turnFactor = baseTurnFactor * (1 + (durationFocus * 7.5) + (distanceDetourAllowance * 1.5));

  const ignoreCycleroutes = distanceFocus >= 0.55 || distanceDetourAllowance >= 0.55 || durationFocus >= 0.65;
  const distDetourRelief = distanceFocus > 0
    ? (inClimbMode
        ? clamp(1 - (distanceFocus * 0.7), 0.24, 1)
        : clamp(1 - (distanceFocus * 0.42), 0.5, 1))
    : 1 + (distanceDetourAllowance * 2.6);
  const distDirectPenalty = 1 + (distanceFocus * (inClimbMode ? 6.2 : 3.4));
  const durSlowPenalty = 1 + (durationFocus * 4.5);
  const durFastPenalty = durationRelax > 0 ? 1 + (durationRelax * 0.55) : 1;
  const durMinorPenalty = 1 + (durationFocus * 3.2);
  const signalPenalty = Math.round(20 + (durationFocus * 260) + (tranquilityFocus * 60));

  const tranqConsiderNoise = tranquilityFocus >= 0.35;
  const tranqStickToCycleroutes = tranquilityFocus >= 0.65;
  const considerTraffic = tranquilityFocus >= 0.2 || durationFocus >= 0.3;
  const avoidUnsafe = tranquilityFocus >= 0.2 || durationFocus >= 0.35;
  const tranqMajorPenalty = 1 + (tranquilityFocus * 15.0);
  const tranqFastTrafficPenalty = 1 + (tranquilityFocus * 22.0);
  const tranqBackgroundPenalty = 1 + (tranquilityFocus * 1.9);
  const citiesMult =
    roadTypes.cities === 'forbid' ? 50.0
      : roadTypes.cities === 'avoid' ? 8.0
        : tranquilityFocus >= 0.6 ? 1 + (tranquilityFocus * 22.0)
          : 1.0;
  const considerTown =
    roadTypes.cities === 'avoid' ||
    roadTypes.cities === 'forbid' ||
    tranquilityFocus >= 0.2;
  const townPenaltyScale = 1 + (tranquilityFocus * 8.0);
  const trafficPenaltyScale = 1 + (tranquilityFocus * 13.0) + (durationFocus * 1.4);
  const forestReliefByClass = tranquilityFocus > 0
    ? buildBonusByClass(1 + (tranquilityFocus * 1.4), clamp(1 - (tranquilityFocus * 0.82), 0.18, 1))
    : buildReliefByClass(1);
  const riverReliefByClass = tranquilityFocus > 0
    ? buildBonusByClass(1 + (tranquilityFocus * 1.2), clamp(1 - (tranquilityFocus * 0.78), 0.22, 1))
    : buildReliefByClass(1);

  const totalMass = expertValue(expert, 'totalMass', defaultFor('totalMass') as number);
  const maxSpeedBase = expertValue(expert, 'maxSpeed', defaultFor('maxSpeed') as number);
  const sCx = expertValue(expert, 'S_C_x', defaultFor('S_C_x') as number);
  const cR = expertValue(expert, 'C_r', defaultFor('C_r') as number);
  const bikerPowerBase = expertValue(expert, 'bikerPower', defaultFor('bikerPower') as number);
  const maxSpeed = maxSpeedBase * clamp(1 + (durationFocus * 0.1) - (durationRelax * 0.05), 0.85, 1.12);
  const bikerPower = bikerPowerBase * clamp(1 + (durationFocus * 0.16) - (durationRelax * 0.08), 0.8, 1.22);
  const stickToCycleRoutes = expertValue(expert, 'stick_to_cycleroutes', false) || tranqStickToCycleroutes;
  const useProposedCycleRoutes = expertValue(expert, 'use_proposed_cycleroutes', false);
  const considerNoise = expertValue(expert, 'consider_noise', false) || tranqConsiderNoise;
  const considerRiver = expertValue(expert, 'consider_river', false) || tranquilityFocus >= 0.45;
  const considerForest = expertValue(expert, 'consider_forest', false) || tranquilityFocus >= 0.45;
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
  };
}