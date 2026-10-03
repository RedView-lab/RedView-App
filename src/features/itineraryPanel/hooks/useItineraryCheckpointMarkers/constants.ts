/** Icônes et seuils de zoom des marqueurs de checkpoint (départ, arrivée, pause, waypoint). */

export const CHECKPOINT_START_ICON = '/svgv2/icone/checkpoint-start.svg';
export const CHECKPOINT_END_ICON = '/svgv2/icone/checkpoint-end.svg';
export const CHECKPOINT_PAUSE_ICON = '/svgv2/icone/checkpoint-pause.svg';
export const CHECKPOINT_WAYPOINT_ICON = '/svgv2/icone/checkpoint-waypoint.svg';

export const UI_ICON_URLS = {
  star: '/svgv2/icone/star-01.svg',
  globe: '/right-click-icons/globe-06.svg',
  chevron: '/svgv2/icone/chevron-down.svg',
  check: '/svgv2/icone/check.svg',
  trash: '/right-click-icons/trash-01.svg',
  pausePin: '/svgv2/icone/checkpoint-pause.svg',
} as const;

export const PAUSE_DURATION_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;

export const MARKER_MIN_SCALE_ZOOM = 6.2;
export const MARKER_MAX_SCALE_ZOOM = 15.1;
export const MARKER_MIN_SCREEN_SCALE = 0.35;
export const MARKER_MAX_SCREEN_SCALE = 1.0;
export const CHECKPOINT_MIN_ZOOM = 6.0;
