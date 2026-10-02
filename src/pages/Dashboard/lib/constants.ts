export const PANEL_WIDTH_KEY = 'rvc-panel-width';
export const LEFT_PANEL_WIDTH_MIN = 360;
export const PANEL_WIDTH_MIN_FALLBACK = LEFT_PANEL_WIDTH_MIN;
export const PANEL_WIDTH_MAX = 560;
export const PANEL_WIDTH_DEFAULT = 300;
export const PANEL_PADDING = 12;
export const PANEL_COLLAPSE_DRAG_THRESHOLD = 64;
export const RIGHT_PANEL_COLLAPSED_RAIL_WIDTH = 40;
export const COLLAPSED_DRAWER_CLEARANCE = 46;
export const CENTER_PANEL_HEIGHT_KEY = 'rvc-center-panel-height';

export const LEFT_PANEL_WIDTH_KEY = 'rvi-panel-width';
export const LEFT_PANEL_WIDTH_MAX = 800;
export const LEFT_PANEL_WIDTH_DEFAULT = 360;

export const CENTER_PANEL_MIN_WIDTH = 420;
/**
 * Center column width under which, with both side panels at their minimum,
 * one side panel gives way (lib/layout.ts): the analysis toolbar then still
 * fits on two rows above the chart.
 */
export const CENTER_PANEL_COMFORT_WIDTH = 560;
export const CENTER_PANEL_MIN_HEIGHT = 390;
export const CENTER_PANEL_MIN_HEIGHT_RATIO = 0.38;
export const CENTER_PANEL_DEFAULT_HEIGHT_RATIO = 0.44;
export const CENTER_PANEL_MAX_HEIGHT_RATIO = 0.58;
export const MAP_VIEWPORT_CONTROLS_TOTAL_HEIGHT = 360;
export const CENTER_PANEL_MIN_MAP_STAGE = PANEL_PADDING + MAP_VIEWPORT_CONTROLS_TOTAL_HEIGHT + PANEL_PADDING; // 384px
export const CENTER_TOOLBAR_HEIGHT = 48;
/** Barre de recherche du haut de la carte (`.rvd-place-search__panel-toggle`, dashboard-place-search.css). */
export const DASHBOARD_SEARCH_BAR_HEIGHT = 40;
export const CENTER_PANEL_STACK_GAP = PANEL_PADDING;
export const CENTER_PANEL_RESIZE_HIT_AREA = 18;

// Short canvas (1366×768 or 1080p laptop at 125–150 %, the UI stays 1:1 — see
// shared/lib/appScale.ts): below the height the regular vertical stack needs,
// the map tools switch to a 2-column grid of 32 px buttons and the center
// panel gets denser and may get shorter.
export const SHORT_CANVAS_HEIGHT =
  PANEL_PADDING + CENTER_TOOLBAR_HEIGHT + CENTER_PANEL_STACK_GAP + CENTER_PANEL_MIN_MAP_STAGE + CENTER_PANEL_MIN_HEIGHT; // 846px
/** 4 rows × 32 px + 3 gaps × 4 px (.rvmvc-map-tools--compact, mapViewportControls/styles). */
export const MAP_VIEWPORT_CONTROLS_COMPACT_HEIGHT = 140;
export const MAP_VIEWPORT_CONTROLS_WIDTH = 40;
/** 2 columns × 32 px + 4 px gap. */
export const MAP_VIEWPORT_CONTROLS_COMPACT_WIDTH = 68;
export const CENTER_PANEL_MIN_HEIGHT_COMPACT = 240;

export const IMMERSIVE_TRANSITION_MS = 320;
export const IMMERSIVE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

// UI density (fluid canvas scale): src/shared/lib/appScale.ts.
