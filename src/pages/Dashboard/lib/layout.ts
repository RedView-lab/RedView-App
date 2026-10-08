import { computeAppScale, type AppScaleViewport } from '@/shared/lib/appScale';
import {
  CENTER_PANEL_COMFORT_WIDTH,
  CENTER_PANEL_DEFAULT_HEIGHT_RATIO,
  CENTER_PANEL_MAX_HEIGHT_RATIO,
  CENTER_PANEL_MIN_HEIGHT,
  CENTER_PANEL_MIN_HEIGHT_COMPACT,
  CENTER_PANEL_MIN_MAP_STAGE,
  CENTER_PANEL_MIN_WIDTH,
  CENTER_PANEL_RESIZE_HIT_AREA,
  CENTER_PANEL_STACK_GAP,
  CENTER_TOOLBAR_HEIGHT,
  LEFT_PANEL_WIDTH_MIN,
  MAP_VIEWPORT_CONTROLS_COMPACT_HEIGHT,
  MAP_VIEWPORT_CONTROLS_COMPACT_WIDTH,
  MAP_VIEWPORT_CONTROLS_WIDTH,
  PANEL_PADDING,
  PANEL_WIDTH_MIN_FALLBACK,
  SHORT_CANVAS_HEIGHT,
} from './constants';
import { clampNumber } from './utils';

function reservedWidth(width: number, collapsed: boolean) {
  return collapsed ? PANEL_PADDING : width + PANEL_PADDING * 2;
}

export type SidePanelSide = 'left' | 'right';

/**
 * Les panneaux latéraux cèdent la place au panneau central quand le canvas
 * logique est trop étroit pour les largeurs préférées de l'utilisateur
 * (fenêtre en demi-écran, portable 16:10 : le canvas reste en 1:1, voir
 * shared/lib/appScale.ts) : le panneau de droite rétrécit d'abord, puis celui
 * de gauche, jamais sous leur minimum. Les largeurs préférées restent dans
 * l'état et reviennent dès que le canvas est de nouveau assez large.
 */
function fitSidePanelWidths({
  designW,
  leftPanelWidth,
  rightPanelWidth,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
}: {
  designW: number;
  leftPanelWidth: number;
  rightPanelWidth: number;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
}) {
  let left = leftPanelWidth;
  let right = rightPanelWidth;
  let overflow =
    reservedWidth(left, isLeftPanelCollapsed) +
    reservedWidth(right, isRightPanelCollapsed) +
    CENTER_PANEL_MIN_WIDTH -
    designW;

  if (overflow > 0 && !isRightPanelCollapsed) {
    const give = Math.min(overflow, Math.max(0, right - PANEL_WIDTH_MIN_FALLBACK));
    right -= give;
    overflow -= give;
  }
  if (overflow > 0 && !isLeftPanelCollapsed) {
    const give = Math.min(overflow, Math.max(0, left - LEFT_PANEL_WIDTH_MIN));
    left -= give;
  }

  return { left, right };
}

/** Canvas le plus étroit qui contient les deux panneaux latéraux (à leur minimum) et un panneau central confortable. */
const BOTH_SIDE_PANELS_MIN_CANVAS_WIDTH =
  reservedWidth(LEFT_PANEL_WIDTH_MIN, false) +
  reservedWidth(PANEL_WIDTH_MIN_FALLBACK, false) +
  CENTER_PANEL_COMFORT_WIDTH;

/**
 * Quand les largeurs minimales laissent le panneau central trop étroit
 * (fenêtre 1080p en demi-écran ~960 px, portable 1280 px), les panneaux
 * latéraux alternent au lieu d'écraser le panneau central : celui que
 * l'utilisateur a ouvert en dernier (`priority`) reste, l'autre est affiché
 * replié.
 * Rien n'est écrit dans l'état : le panneau masqué revient de lui-même quand
 * le canvas s'élargit, ou quand l'utilisateur l'ouvre (il prend alors la
 * priorité).
 */
function resolveSidePanels({
  designW,
  leftPanelWidth,
  rightPanelWidth,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
  priority,
}: {
  designW: number;
  leftPanelWidth: number;
  rightPanelWidth: number;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  priority: SidePanelSide;
}) {
  let leftCollapsed = isLeftPanelCollapsed;
  let rightCollapsed = isRightPanelCollapsed;
  if (!leftCollapsed && !rightCollapsed && designW < BOTH_SIDE_PANELS_MIN_CANVAS_WIDTH) {
    if (priority === 'right') leftCollapsed = true;
    else rightCollapsed = true;
  }
  const widths = fitSidePanelWidths({
    designW,
    leftPanelWidth,
    rightPanelWidth,
    isLeftPanelCollapsed: leftCollapsed,
    isRightPanelCollapsed: rightCollapsed,
  });
  return { ...widths, leftCollapsed, rightCollapsed };
}

interface DashboardLayoutInput {
  viewport: AppScaleViewport;
  panelWidth: number;
  leftPanelWidth: number;
  exporterPanelHeight: number;
  centerPanelHeightOverride: number | null;
  isLeftPanelCollapsed: boolean;
  isCenterPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  /** Panneau latéral gardé quand le canvas est trop étroit pour les deux (le dernier ouvert). */
  sidePanelPriority?: SidePanelSide;
}

export function getDashboardLayout({
  viewport,
  panelWidth,
  leftPanelWidth,
  exporterPanelHeight,
  centerPanelHeightOverride,
  isLeftPanelCollapsed: isLeftPanelCollapsedPreference,
  isCenterPanelCollapsed,
  isRightPanelCollapsed: isRightPanelCollapsedPreference,
  sidePanelPriority = 'left',
}: DashboardLayoutInput) {
  // Densité fluide de l'interface — voir src/shared/lib/appScale.ts.
  const appScale = computeAppScale(viewport);
  const scaledViewportWidth = viewport.w / appScale;
  const scaledViewportHeight = viewport.h / appScale;
  const designW = scaledViewportWidth;
  const designH = scaledViewportHeight;

  const rightDockContentHeight = Math.max(0, designH - PANEL_PADDING * 2);
  const rightPrimaryPanelHeight = Math.max(
    0,
    rightDockContentHeight - exporterPanelHeight - PANEL_PADDING,
  );

  const fittedPanels = resolveSidePanels({
    designW,
    leftPanelWidth,
    rightPanelWidth: panelWidth,
    isLeftPanelCollapsed: isLeftPanelCollapsedPreference,
    isRightPanelCollapsed: isRightPanelCollapsedPreference,
    priority: sidePanelPriority,
  });
  const isLeftPanelCollapsed = fittedPanels.leftCollapsed;
  const isRightPanelCollapsed = fittedPanels.rightCollapsed;

  // Canvas court : outils de carte compacts, minimum du panneau central plus bas.
  const isShortCanvas = designH < SHORT_CANVAS_HEIGHT;
  const mapToolsWidth = isShortCanvas ? MAP_VIEWPORT_CONTROLS_COMPACT_WIDTH : MAP_VIEWPORT_CONTROLS_WIDTH;
  const mapStageMinClearance = isShortCanvas
    ? PANEL_PADDING * 2 + MAP_VIEWPORT_CONTROLS_COMPACT_HEIGHT
    : CENTER_PANEL_MIN_MAP_STAGE;
  const centerPanelMinHeightTarget = isShortCanvas ? CENTER_PANEL_MIN_HEIGHT_COMPACT : CENTER_PANEL_MIN_HEIGHT;
  const leftPanelReservedWidth = reservedWidth(fittedPanels.left, isLeftPanelCollapsed);
  const centerPanelBaseRegionLeft = leftPanelReservedWidth;
  const rightPanelReservedWidth = reservedWidth(fittedPanels.right, isRightPanelCollapsed);
  // Largeur maximale à laquelle chaque panneau peut être tiré pendant que
  // l'autre garde sa largeur et que le panneau central garde
  // CENTER_PANEL_MIN_WIDTH.
  const leftPanelMaxWidth =
    designW - rightPanelReservedWidth - CENTER_PANEL_MIN_WIDTH - PANEL_PADDING * 2;
  const rightPanelMaxWidth =
    designW - leftPanelReservedWidth - CENTER_PANEL_MIN_WIDTH - PANEL_PADDING * 2;
  const centerPanelBaseRegionRight = rightPanelReservedWidth;
  const centerPanelRegionLeft = leftPanelReservedWidth;
  const centerPanelRegionRight = rightPanelReservedWidth;

  const centerToolbarWidth = Math.max(
    0,
    designW - centerPanelBaseRegionLeft - centerPanelBaseRegionRight,
  );
  const centerPanelAvailableWidth = Math.max(
    0,
    designW - centerPanelRegionLeft - centerPanelRegionRight,
  );
  const centerToolbarVisible = centerToolbarWidth >= CENTER_PANEL_MIN_WIDTH;
  const centerPanelVisible = centerToolbarVisible && !isCenterPanelCollapsed;
  const centerPanelWidth = centerPanelAvailableWidth;

  const centerPanelAvailableHeight = Math.max(
    0,
    designH - PANEL_PADDING * 2 - CENTER_TOOLBAR_HEIGHT - CENTER_PANEL_STACK_GAP,
  );
  // Garantit que la scène de carte du haut garde toujours assez de hauteur pour
  // les contrôles du haut (PlaceSearch en haut à gauche et MapViewportControls
  // en haut à droite) plus une marge d'espacement uniforme.
  const minMapStageClearance = Math.max(
    mapStageMinClearance,
    Math.round(designH * 0.25),
  );
  const centerPanelMaxAvailableHeight = Math.max(
    0,
    designH - PANEL_PADDING - CENTER_TOOLBAR_HEIGHT - CENTER_PANEL_STACK_GAP - minMapStageClearance,
  );

  const centerPanelMaxHeight = Math.max(
    centerPanelMinHeightTarget,
    Math.min(
      centerPanelMaxAvailableHeight,
      Math.round(centerPanelAvailableHeight * CENTER_PANEL_MAX_HEIGHT_RATIO),
    ),
  );
  const centerPanelMinHeight = Math.min(
    centerPanelMaxHeight,
    centerPanelMinHeightTarget,
  );
  const centerPanelDesiredHeight = clampNumber(
    Math.round(centerPanelAvailableHeight * CENTER_PANEL_DEFAULT_HEIGHT_RATIO),
    centerPanelMinHeight,
    centerPanelMaxHeight,
  );
  const centerPanelTargetHeight =
    centerPanelHeightOverride ?? centerPanelDesiredHeight;
  const centerPanelHeight = clampNumber(
    centerPanelTargetHeight,
    centerPanelMinHeight,
    centerPanelMaxHeight,
  );

  const centerPanelLeft = centerPanelRegionLeft;
  const centerPanelTop = designH - PANEL_PADDING - centerPanelHeight;
  const centerToolbarLeft = centerPanelBaseRegionLeft;
  const centerToolbarTop = isCenterPanelCollapsed
    ? designH - PANEL_PADDING - CENTER_TOOLBAR_HEIGHT
    : centerPanelTop - CENTER_PANEL_STACK_GAP - CENTER_TOOLBAR_HEIGHT;
  const centerPanelResizeHitTop =
    centerToolbarTop +
    CENTER_TOOLBAR_HEIGHT -
    Math.max(0, Math.round((CENTER_PANEL_RESIZE_HIT_AREA - CENTER_PANEL_STACK_GAP) / 2));

  return {
    appScale,
    scaledViewportWidth,
    scaledViewportHeight,
    designW,
    designH,
    isShortCanvas,
    mapToolsWidth,
    // États de repli tels que rendus (voir resolveSidePanels).
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    leftPanelWidth: fittedPanels.left,
    rightPanelWidth: fittedPanels.right,
    leftPanelMaxWidth,
    rightPanelMaxWidth,
    rightPrimaryPanelHeight,
    centerToolbarWidth,
    centerToolbarVisible,
    centerPanelVisible,
    centerPanelWidth,
    centerPanelMinHeight,
    centerPanelMaxHeight,
    centerPanelHeight,
    centerPanelLeft,
    centerPanelTop,
    centerToolbarLeft,
    centerToolbarTop,
    centerPanelResizeHitTop,
  };
}
