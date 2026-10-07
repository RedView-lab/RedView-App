/** Icônes et seuils de zoom des marqueurs de checkpoint (départ, arrivée, pause, waypoint). */

export const CHECKPOINT_START_ICON = '/icons/ui/checkpoint-start.svg';
export const CHECKPOINT_END_ICON = '/icons/ui/checkpoint-end.svg';
export const CHECKPOINT_PAUSE_ICON = '/icons/ui/checkpoint-pause.svg';
export const CHECKPOINT_WAYPOINT_ICON = '/icons/ui/checkpoint-waypoint.svg';

export const UI_ICON_URLS = {
  star: '/icons/ui/star-01.svg',
  globe: '/icons/context-menu/globe-06.svg',
  chevron: '/icons/ui/chevron-down.svg',
  check: '/icons/ui/check.svg',
  trash: '/icons/context-menu/trash-01.svg',
  pausePin: '/icons/ui/checkpoint-pause.svg',
} as const;

export const PAUSE_DURATION_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;

export const MARKER_MIN_SCALE_ZOOM = 6.2;
export const MARKER_MAX_SCALE_ZOOM = 15.1;
export const MARKER_MIN_SCREEN_SCALE = 0.35;
export const MARKER_MAX_SCREEN_SCALE = 1.0;
export const CHECKPOINT_MIN_ZOOM = 6.0;
