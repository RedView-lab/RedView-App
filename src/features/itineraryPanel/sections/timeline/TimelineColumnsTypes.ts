import type { PredictionPoint, PredictionResult } from '@/features/fitPredictor';
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
  pinned?: boolean;
  custom?: boolean;
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
}
