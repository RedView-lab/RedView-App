import type { PredictionResult } from '@/features/fitPredictor';
import type { PoiCategory, RhythmState, TimelineItem, TimelineRailConfig } from '../../../types';

export interface TimelineTimelineViewProps {
  items: TimelineItem[];
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  config?: Partial<TimelineRailConfig>;
  markerStepKm?: number;
  hourZoom?: number;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  onChangeFavoritePoiPauseDuration?: (category: PoiCategory, durationMin: number) => void;
  onRegisterPauseInsertionResolver?: (resolver: (() => number | null) | null) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
}

export interface StartReference {
  reference: Date | null;
  hasRealDate: boolean;
  startMinutes: number;
}

export interface TimedTimelineItem {
  item: TimelineItem;
  sortIndex: number;
  distanceKm: number;
  rideElapsedSeconds: number;
  elapsedSeconds: number;
  minuteOfDay: number;
  date: Date | null;
  dayKey: string | null;
}

export interface TimedIntervalPause {
  id: string;
  label: string;
  sortIndex: number;
  distanceKm: number;
  durationMin: number;
  visible: boolean;
  rideElapsedSeconds: number;
  elapsedSeconds: number;
  minuteOfDay: number;
  date: Date | null;
  dayKey: string | null;
}

export interface TimelineStopAnchor {
  id: string;
  rideElapsedSeconds: number;
  scheduledElapsedSeconds: number;
  durationMin: number;
}

export interface ScheduledTimelineState {
  timedItems: TimedTimelineItem[];
  intervalPauses: TimedIntervalPause[];
  stopAnchors: TimelineStopAnchor[];
}

export interface AttachedPause {
  id: string;
  durationMin: number;
  visible: boolean;
  heightPx: number;
}

export interface EventSpanSegment {
  dayKey: string | null;
  topPx: number;
  heightPx: number;
}

export interface TimelineEvent extends TimedTimelineItem {
  scheduledTopPx: number;
  topPx: number;
  attachedPauses: AttachedPause[];
  toNextSeconds: number | null;
  displayDurationMin: number;
  cardHeightPx: number;
  heightPx: number;
  spanSegments: EventSpanSegment[];
}

export interface TimelineStandalonePause {
  id: string;
  label: string;
  source: 'manual' | 'interval';
  distanceKm: number;
  elapsedSeconds: number;
  scheduledTopPx: number;
  topPx: number;
  durationMin: number;
  toNextSeconds: number | null;
  visible: boolean;
  heightPx: number;
  sortIndex: number;
  dayKey: string | null;
}

export interface PauseAttachmentState {
  attachedByEventId: Map<string, Array<Omit<AttachedPause, 'heightPx'>>>;
  unattachedPauses: TimedTimelineItem[];
}

export interface TimelinePositioningResult {
  events: TimelineEvent[];
  standalonePauses: TimelineStandalonePause[];
  canvasHeight: number;
  firstVisibleTopPx: number | null;
}

export interface KmMarker {
  id: string;
  label: string;
  topPx: number;
}