import type { PrioritiesState, RoadTypesState } from '../../src/features/itineraryPanel/types';

// Environnement, itinéraires de test et réglages de tracé de référence.

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { _flush?: () => void };
  exitCode?: number;
  exit(code?: number): never;
};

export const UPSTREAM =
  process.env.BROUTER_UPSTREAM?.replace(/\/+$/, '') ?? 'http://localhost:17777';
export const WATCHDOG_RETRY_DELAYS_MS = [250, 700, 1500];
export const ONLY_GROUPS = new Set(
  (process.env.BROUTER_BENCH_GROUPS ?? '')
    .split(',')
    .map((group: string) => group.trim().toUpperCase())
    .filter(Boolean),
);

const PT = {
  chamonix: { lat: 45.9237, lon: 6.8694 },
  grenoble: { lat: 45.1885, lon: 5.7245 },
  autun: { lat: 46.9517, lon: 4.2994 },
  clamecy: { lat: 47.4608, lon: 3.5203 },
} as const;

export interface BenchRoute {
  from: Point;
  to: Point;
  label: string;
}

export const DEFAULT_ROUTE: BenchRoute = { from: PT.chamonix, to: PT.grenoble, label: 'Chamonix → Grenoble (Alps)' };
export const MORVAN_ROUTE: BenchRoute = { from: PT.autun, to: PT.clamecy, label: 'Autun → Clamecy (Morvan)' };

export type Point = { lat: number; lon: number };

export const NEUTRAL_PRIORITIES: PrioritiesState = {
  duration: 50, elevation: 50, distance: 50, tranquility: 50,
};

export function rt(over: Partial<RoadTypesState> = {}): RoadTypesState {
  return {
    road: 'tolerate', gravel: 'tolerate', singletrack: 'tolerate',
    offroad: 'tolerate', bikeLanes: 'tolerate', majorRoads: 'tolerate',
    ferry: 'tolerate', turns: 'tolerate', cities: 'tolerate',
    maxSlopePercent: 99, applyToAllItineraries: false,
    ...over,
  };
}

export function pri(over: Partial<PrioritiesState> = {}): PrioritiesState {
  return { ...NEUTRAL_PRIORITIES, ...over };
}

export interface RouteStats {
  distanceKm: number;
  ascentM: number;
  descentM: number;
  durationMin: number;
  tortuosity: number;
  status: number;
  profileId: string;
  coordinates?: [number, number][];
  error?: string;
}
