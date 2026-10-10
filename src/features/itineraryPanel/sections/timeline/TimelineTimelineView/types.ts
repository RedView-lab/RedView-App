import type { PredictionResult } from '@/features/fitPredictor';
import type { PoiCategory, RhythmState, TimelineItem, TimelineRailConfig } from '../../../types';
import type { TimelineFilterState } from '../TimelineFilters';

export interface TimelineTimelineViewProps {
  /**
   * Tous les items de l'itinéraire : le planning (heures, pauses cumulées,
   * repères km) se calcule toujours sur l'ensemble.
   */
  items: TimelineItem[];
  /**
   * Items à afficher (filtres). Absent = tout afficher. Filtrer `items` à la
   * place retirerait les pauses masquées du planning et décalerait les heures.
   */
  visibleIds?: ReadonlySet<string>;
  rhythm?: RhythmState;
  prediction?: PredictionResult | null;
  config?: Partial<TimelineRailConfig>;
  markerStepKm?: number;
  hourZoom?: number;
  onHourZoomChange?: (zoom: number) => void;
  selectedIds?: ReadonlySet<string>;
  filters?: TimelineFilterState;
  onSelectRow?: (id: string, item: TimelineItem) => void;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onMovePause?: (id: string, distanceKm: number) => void;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onChangeIntervalPauseDuration?: (pauseIntervalId: string, durationMin: number) => void;
  onRegisterPauseInsertionResolver?: (resolver: (() => number | null) | null) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  /** Nom saisi pour un POI (double-clic sur son nom, ou F2). */
  onRename?: (id: string, label: string) => void;
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

export interface TimedAutoPause {
  id: string;
  label: string;
  source: 'interval' | 'favorite-poi';
  attachedToItemId: string | null;
  poiCategory?: PoiCategory;
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
  label?: string;
  rideElapsedSeconds: number;
  scheduledElapsedSeconds: number;
  durationMin: number;
}

export interface ScheduledTimelineState {
  timedItems: TimedTimelineItem[];
  autoPauses: TimedAutoPause[];
  stopAnchors: TimelineStopAnchor[];
}

export interface AttachedPause {
  id: string;
  durationMin: number;
  visible: boolean;
  heightPx: number;
  source: 'favorite-poi';
}

export interface EventSpanSegment {
  dayKey: string | null;
  /** Position horaire du segment, avant empilement (positionTimelineBlocks). */
  scheduledTopPx: number;
  topPx: number;
  heightPx: number;
  /** Part des pauses attachées qui tombe dans ce jour (suite après minuit). */
  pauseHeightPx: number;
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
  /** Commencé la veille du premier jour affiché : seule sa suite (segments) est dessinée. */
  startsBeforeWindow: boolean;
}

export interface TimelineStandalonePause {
  id: string;
  label: string;
  source: 'manual' | 'interval' | 'favorite-poi';
  poiCategory?: PoiCategory;
  /** Pause d'un POI favori : la ligne du POI, qui porte sa durée. */
  attachedToItemId?: string | null;
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
  /** Suite de la pause dans les jours suivants quand elle passe minuit. */
  continuations: EventSpanSegment[];
  /** Commencée la veille du premier jour affiché : seule sa suite est dessinée. */
  startsBeforeWindow: boolean;
}

/**
 * Durée de pause en cours de saisie dans l'agenda : celle d'une ligne (pause
 * posée, ou POI — sa durée à lui seul) ou d'une règle d'intervalle.
 */
export interface PauseDurationEditState {
  kind: 'row' | 'interval';
  targetId: string;
  draft: string;
  previousDurationMin: number;
}

export interface PauseAttachmentState {
  attachedByEventId: Map<string, Array<Omit<AttachedPause, 'heightPx'>>>;
  unattachedPauses: TimedAutoPause[];
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