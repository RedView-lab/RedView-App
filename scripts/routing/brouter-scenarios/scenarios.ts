import { pri, rt } from './config';
import type { Scenario } from './runner';

export const BASELINE_SCENARIOS: Scenario[] = [
  { name: '0a stock trekking',         stockProfile: 'trekking' },
  { name: '0b default (all neutral)' },
];

export const ELEV_SCENARIOS: Scenario[] = [
  { name: 'E0  elevation=0   max-flat',   priorities: pri({ elevation: 0 }) },
  { name: 'E1  elevation=25  avoid hills',priorities: pri({ elevation: 25 }) },
  { name: 'E2  elevation=50  neutral',    priorities: pri({ elevation: 50 }) },
  { name: 'E3  elevation=75  seek hills', priorities: pri({ elevation: 75 }) },
  { name: 'E4  elevation=100 max-hilly',  priorities: pri({ elevation: 100 }) },
];

export const DIST_SCENARIOS: Scenario[] = [
  { name: 'D0  distance=0    shortest',   priorities: pri({ distance: 0 }) },
  { name: 'D1  distance=50   neutral',    priorities: pri({ distance: 50 }) },
  { name: 'D2  distance=100  scenic',     priorities: pri({ distance: 100 }) },
];

export const MAX_DISTANCE_CLIMB_SCENARIOS: Scenario[] = [
  { name: 'X0  neutral baseline',              priorities: pri() },
  {
    name: 'X1  distance=0 elevation=100  smart climb',
    priorities: pri({ distance: 0, elevation: 100 }),
    preferClimbEfficiencySearch: true,
  },
  { name: 'X2  distance=100 elevation=100',    priorities: pri({ distance: 100, elevation: 100 }) },
];

export const DUR_SCENARIOS: Scenario[] = [
  { name: 'T0  duree=0   no rush',         priorities: pri({ duration: 0 }) },
  { name: 'T1  duree=50  neutral',         priorities: pri({ duration: 50 }) },
  { name: 'T2  duree=100 fast / direct',   priorities: pri({ duration: 100 }) },
];

export const TRANQ_SCENARIOS: Scenario[] = [
  { name: 'Q0  tranq=0   traffic OK',     priorities: pri({ tranquility: 0 }) },
  { name: 'Q1  tranq=50  neutral',        priorities: pri({ tranquility: 50 }) },
  { name: 'Q2  tranq=100 max quiet',      priorities: pri({ tranquility: 100 }) },
];

export const SLOPE_SCENARIOS: Scenario[] = [
  { name: 'S0 maxSlope=99 (off)',         roadTypes: rt({ maxSlopePercent: 99 }) },
  { name: 'S1 maxSlope=15',               roadTypes: rt({ maxSlopePercent: 15 }) },
  { name: 'S2 maxSlope=8',                roadTypes: rt({ maxSlopePercent: 8 }) },
  { name: 'S3 maxSlope=4',                roadTypes: rt({ maxSlopePercent: 4 }) },
];

export const ROADTYPE_SCENARIOS: Scenario[] = [
  { name: 'R0 default (all tolerate)' },
  { name: 'R1 forbid singletrack',                roadTypes: rt({ singletrack: 'forbid' }) },
  { name: 'R2 forbid offroad',                    roadTypes: rt({ offroad: 'forbid' }) },
  { name: 'R3 forbid majorRoads',                 roadTypes: rt({ majorRoads: 'forbid' }) },
  { name: 'R4 forbid road, prefer gravel',        roadTypes: rt({ road: 'forbid', gravel: 'prefer' }) },
  { name: 'R5 prefer road, forbid gravel/sing.',  roadTypes: rt({ road: 'prefer', gravel: 'forbid', singletrack: 'forbid', offroad: 'forbid' }) },
  { name: 'R6 prefer bikeLanes',                  roadTypes: rt({ bikeLanes: 'prefer' }) },
  { name: 'R7 forbid ferries',                    roadTypes: rt({ ferry: 'forbid' }) },
];

export const TURNS_SCENARIOS: Scenario[] = [
  { name: 'V0 turns prefer',     roadTypes: rt({ turns: 'prefer' }) },
  { name: 'V1 turns tolerate',   roadTypes: rt({ turns: 'tolerate' }) },
  { name: 'V2 turns avoid',      roadTypes: rt({ turns: 'avoid' }) },
  { name: 'V3 turns forbid',     roadTypes: rt({ turns: 'forbid' }) },
];

export const CITIES_SCENARIOS: Scenario[] = [
  { name: 'C0 cities tolerate',  roadTypes: rt({ cities: 'tolerate' }) },
  { name: 'C1 cities avoid',     roadTypes: rt({ cities: 'avoid' }) },
  { name: 'C2 cities forbid',    roadTypes: rt({ cities: 'forbid' }) },
];
