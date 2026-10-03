import type { FlyoverRoutePoint } from './engine/routeTrack';

/**
 * Cycle de vie d'une lecture :
 * idle → approaching (survol jusqu'au rail) → handoff (raccord) → playing
 * ⇄ pausing → paused ; playing → arriving (freinage + tenue) → overview
 * (vue d'ensemble) → ended.
 */
export type FlyoverPhase =
  | 'idle'
  | 'approaching'
  | 'handoff'
  | 'playing'
  | 'pausing'
  | 'paused'
  | 'arriving'
  | 'overview'
  | 'ended';

export interface FlyoverStatus {
  readonly canPlay: boolean;
  readonly phase: FlyoverPhase;
  /** Lecture en cours ou sur le point de reprendre (icône Pause). */
  readonly isPlaying: boolean;
  /** Une session est ouverte : tête, traînée, tracé normal masqué. */
  readonly playbackActive: boolean;
  readonly speedIndex: number;
  /** Position de la tête (m) pendant une session. */
  readonly distanceM: number | null;
  readonly totalM: number;
  /** Temps de lecture écoulé et total au palier de vitesse courant (s). */
  readonly elapsedS: number;
  readonly durationS: number;
}

export interface FlyoverRouteInput {
  readonly itineraryId: string;
  readonly points: readonly FlyoverRoutePoint[];
  /** Distance cumulée de chaque point, même repère que le graphique d'analyse. */
  readonly distancesM: readonly number[];
  readonly color: string;
}

export interface FlyoverInput {
  readonly route: FlyoverRouteInput | null;
  /** Abscisse du graphique pour une distance sur la trace (`null` si non projetable). */
  readonly toChartX: ((distanceM: number) => number | null) | null;
}

export interface AnalysisFlyoverContextValue {
  canPlay: boolean;
  isPlaying: boolean;
  playbackActive: boolean;
  togglePlayback: () => void;
  slowDown: () => void;
  speedUp: () => void;
  resetPlayback: () => void;
  canSlowDown: boolean;
  canSpeedUp: boolean;
  distanceLabel: string;
  timeLabel: string;
}

/**
 * Déplace la tête au point du graphique `x` quand une lecture est ouverte.
 * Rend `false` sinon (le clic garde alors son comportement normal).
 */
export type FlyoverSeekToChartX = (xValue: number) => boolean;
