import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';
import type { SportDiscipline } from '@/shared/lib/discipline';
import type { RhythmState, TimelineItem } from '../../types';
import type { StartReference } from './TimelineTimelineView/types';

export type TimelineColumnId =
  | 'typePicto'
  | 'typeText'
  | 'name'
  | 'distance'
  | 'clockTime'
  | 'elapsedTime'
  | 'segmentTimePrev'
  | 'segmentTimeNext'
  | 'avgSpeedFromStart'
  | 'avgSpeedSincePrev'
  | 'avgSpeedToNext'
  | 'avgPowerFromStart'
  | 'avgPowerSincePrev'
  | 'avgPowerToNext'
  | 'gainFromStart'
  | 'gainSincePrev'
  | 'gainToNext'
  | 'lossFromStart'
  | 'lossSincePrev'
  | 'lossToNext'
  | 'altitude'
  | 'wind'
  | 'temperature'
  | 'rain'
  | 'cloudCover';

import type { RouteWeatherDataset, RouteWeatherValues } from '@/features/weather';

export type TimelineColumnAlign = 'left' | 'right' | 'center';

export interface TimelineColumnContext {
  item: TimelineItem;
  prevItem: TimelineItem | null;
  nextItem: TimelineItem | null;
  distanceM: number | null;
  prevDistanceM: number | null;
  nextDistanceM: number | null;
  totalDistanceM: number;
  prediction: PredictionResult | null | undefined;
  rhythm: RhythmState | undefined;
  reference: StartReference;
  elapsedS: number | null;
  elapsedPrevS: number | null;
  elapsedNextS: number | null;
  point: PredictionPoint | null;
  pointPrev: PredictionPoint | null;
  pointNext: PredictionPoint | null;
  weather?: RouteWeatherValues | null;
  /** Trail / Running show paces (min/km) instead of km/h. */
  discipline: SportDiscipline;
}

export interface TimelineColumnCell {
  display: string;
  sortKey: number | string | null;
}

export interface TimelineColumnDef {
  id: TimelineColumnId;
  label: string;
  shortLabel?: string;
  defaultOn: boolean;
  align: TimelineColumnAlign;
  minWidth: number;
  defaultWidth?: number;
  pinned?: boolean;
  custom?: boolean;
  /** Header labels used for Trail / Running (pace columns). */
  footLabel?: string;
  footShortLabel?: string;
  /** Hidden for Trail / Running (no power model). */
  bikeOnly?: boolean;
  getCell: (ctx: TimelineColumnContext) => TimelineColumnCell;
}

export interface BuildContextArgs {
  item: TimelineItem;
  prevItem: TimelineItem | null;
  nextItem: TimelineItem | null;
  totalDistanceM: number;
  prediction: PredictionResult | null | undefined;
  rhythm: RhythmState | undefined;
  reference: StartReference;
  weatherDataset?: RouteWeatherDataset | null;
  /** Itinerary discipline, used when there is no prediction yet. */
  discipline?: SportDiscipline;
}
