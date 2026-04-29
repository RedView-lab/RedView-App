import type { ExpertProfileState } from '../../../expert/types';
import type { PrioritiesState, RoadTypesState } from '../../../types';

export interface BrfBuildInputs {
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  expert?: ExpertProfileState | null;
}

export interface BrfProfileValues {
  fRoad: number;
  fGravel: number;
  fSingletrack: number;
  fOffroad: number;
  fBikelane: number;
  fMajor: number;
  allowFerries: boolean;
  allowSteps: boolean;
  turnFactor: number;
  distNonCyclePenalty: number;
  durSlowPenalty: number;
  durFastPenalty: number;
  durMinorPenalty: number;
  tranqMajorPenalty: number;
  citiesMult: number;
  climbMul: number;
  ignoreCycleroutes: boolean;
  stickToCycleRoutes: boolean;
  useProposedCycleRoutes: boolean;
  avoidUnsafe: boolean;
  considerNoise: boolean;
  considerRiver: boolean;
  considerForest: boolean;
  considerTown: boolean;
  considerTraffic: boolean;
  considerElevation: boolean;
  downCost: number;
  downCutoff: number;
  upCost: number;
  upCutoff: number;
  elevPenaltyBuffer: number;
  elevMaxBuffer: number;
  elevBufferReduce: number;
  pass1Coefficient: number;
  inClimbMode: boolean;
  maxSlope: number;
  maxSlopeCost: number;
  totalMass: number;
  maxSpeed: number;
  sCx: number;
  cR: number;
  bikerPower: number;
  turnInstructionMode: number;
  considerTurnRestrictions: boolean;
}