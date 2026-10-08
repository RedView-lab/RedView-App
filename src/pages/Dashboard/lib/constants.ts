export const PANEL_WIDTH_KEY = 'rvc-panel-width';
export const LEFT_PANEL_WIDTH_MIN = 360;
export const PANEL_WIDTH_MIN_FALLBACK = LEFT_PANEL_WIDTH_MIN;
export const PANEL_WIDTH_MAX = 560;
export const PANEL_WIDTH_DEFAULT = 300;
export const PANEL_PADDING = 12;
export const PANEL_COLLAPSE_DRAG_THRESHOLD = 64;
export const CENTER_PANEL_HEIGHT_KEY = 'rvc-center-panel-height';

export const LEFT_PANEL_WIDTH_KEY = 'rvi-panel-width';
export const LEFT_PANEL_WIDTH_MAX = 800;
export const LEFT_PANEL_WIDTH_DEFAULT = 360;

export const CENTER_PANEL_MIN_WIDTH = 420;
/**
 * Largeur de la colonne centrale sous laquelle, avec les deux panneaux
 * latéraux à leur minimum, un panneau latéral cède la place (lib/layout.ts) :
 * la barre d'outils d'analyse tient alors encore sur deux lignes au-dessus du
 * graphique.
 */
export const CENTER_PANEL_COMFORT_WIDTH = 560;
export const CENTER_PANEL_MIN_HEIGHT = 390;
export const CENTER_PANEL_DEFAULT_HEIGHT_RATIO = 0.44;
export const CENTER_PANEL_MAX_HEIGHT_RATIO = 0.58;
export const MAP_VIEWPORT_CONTROLS_TOTAL_HEIGHT = 360;
export const CENTER_PANEL_MIN_MAP_STAGE = PANEL_PADDING + MAP_VIEWPORT_CONTROLS_TOTAL_HEIGHT + PANEL_PADDING; // 384px
export const CENTER_TOOLBAR_HEIGHT = 48;
/** Barre de recherche du haut de la carte (`.rvd-place-search__panel-toggle`, dashboard-place-search.css). */
export const DASHBOARD_SEARCH_BAR_HEIGHT = 40;
export const CENTER_PANEL_STACK_GAP = PANEL_PADDING;
export const CENTER_PANEL_RESIZE_HIT_AREA = 18;

// Canvas court (1366×768 ou portable 1080p à 125–150 %, l'interface reste en
// 1:1 — voir shared/lib/appScale.ts) : sous la hauteur que demande la pile
// verticale normale, les outils de la carte passent en grille de 2 colonnes
// de boutons de 32 px et le panneau central devient plus dense et peut
// raccourcir.
export const SHORT_CANVAS_HEIGHT =
  PANEL_PADDING + CENTER_TOOLBAR_HEIGHT + CENTER_PANEL_STACK_GAP + CENTER_PANEL_MIN_MAP_STAGE + CENTER_PANEL_MIN_HEIGHT; // 846px
/** 4 lignes × 32 px + 3 écarts × 4 px (.rvmvc-map-tools--compact, mapViewportControls/styles). */
export const MAP_VIEWPORT_CONTROLS_COMPACT_HEIGHT = 140;
export const MAP_VIEWPORT_CONTROLS_WIDTH = 40;
/** 2 colonnes × 32 px + 4 px d'écart. */
export const MAP_VIEWPORT_CONTROLS_COMPACT_WIDTH = 68;
export const CENTER_PANEL_MIN_HEIGHT_COMPACT = 240;

export const IMMERSIVE_TRANSITION_MS = 320;
export const IMMERSIVE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

// Densité de l'interface (échelle fluide du canvas) : src/shared/lib/appScale.ts.
