import type { ExpertProfileState } from '../../../../expert/types';
import type { PrioritiesState, RoadTypesState } from '../../../../types';
import type { FootDiscipline, SportDiscipline } from '@/shared/lib/discipline';

export interface BrfBuildInputs {
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  expert?: ExpertProfileState | null;
  /** Trail / Running switch the profile to the pedestrian network. */
  discipline?: SportDiscipline;
}

/** Pedestrian-only knobs, set when the itinerary is Trail / Running. */
export interface BrfFootValues {
  style: FootDiscipline;
  /** Ways with a SAC grade above this are forbidden (0 = no SAC path). */
  sacLimit: number;
  /** SAC grade with no penalty; others cost more (above) or slightly more (below). */
  sacPreferred: number;
  /** Cost multiplier on marked hiking / foot routes. */
  hikingRouteFactor: number;
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
  shortestMode: boolean;
  turnFactor: number;
  distDetourRelief: number;
  distDirectPenalty: number;
  durSlowPenalty: number;
  durFastPenalty: number;
  durMinorPenalty: number;
  tranqMajorPenalty: number;
  tranqFastTrafficPenalty: number;
  tranqBackgroundPenalty: number;
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
  signalPenalty: number;
  townPenaltyScale: number;
  trafficPenaltyScale: number;
  forestReliefByClass: [number, number, number, number, number, number];
  riverReliefByClass: [number, number, number, number, number, number];
  downCost: number;
  downCutoff: number;
  upCost: number;
  upCutoff: number;
  elevPenaltyBuffer: number;
  elevMaxBuffer: number;
  elevBufferReduce: number;
  pass1Coefficient: number;
  pass2Coefficient: number;
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
  /** Non-null → pedestrian profile (validForFoot, foot access, no oneway). */
  foot: BrfFootValues | null;
}