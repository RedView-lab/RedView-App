import type { PoiCategory, TimelineItem } from '@/features/itineraryPanel/types';

export interface RouteSample {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number | null;
}

export type StopSource = 'timeline-pause' | 'favorite-poi' | 'interval';

export interface CheckpointSeed {
  id: string;
  label: string;
  kind: TimelineItem['kind'] | 'intervalPause';
  typeLabel: string;
  distanceM: number;
  lat: number;
  lon: number;
  elevationM: number | null;
  poiCategory?: PoiCategory;
  stopMinutes: number;
  stopSource?: StopSource;
  generated: boolean;
  sortIndex: number;
}

export interface SegmentMetrics {
  sectionDistanceM: number;
  ascentM: number;
  descentM: number;
  netGradientPct: number | null;
  sectionRideSeconds: number | null;
  cumulativeRideSeconds: number | null;
  avgSpeedKmh: number | null;
  avgPowerW: number | null;
}

export interface ServiceFlags {
  water: boolean;
  food: boolean;
  sleep: boolean;
  mechanic: boolean;
}

export interface ScheduledCheckpoint extends CheckpointSeed, SegmentMetrics {
  arrivalDate: Date | null;
  departureDate: Date | null;
  arrivalLabel: string;
  departureLabel: string;
  sunriseLabel: string;
  sunsetLabel: string;
  dayPhase: string;
  cumulativeStopMinutes: number;
  serviceFlags: ServiceFlags;
  serviceTags: string;
}

export interface ServiceGapSummary {
  count: number;
  longestDistanceKm: number;
  longestRideLabel: string;
  fromLabel: string;
  toLabel: string;
}