import { computeAppScale } from '@/shared/lib/appScale';
import {
  CENTER_PANEL_DEFAULT_HEIGHT_RATIO,
  CENTER_PANEL_MAX_HEIGHT_RATIO,
  CENTER_PANEL_MIN_HEIGHT,
  CENTER_PANEL_MIN_MAP_STAGE,
  CENTER_PANEL_MIN_WIDTH,
  CENTER_PANEL_RESIZE_HIT_AREA,
  CENTER_PANEL_STACK_GAP,
  CENTER_TOOLBAR_HEIGHT,
  LEFT_PANEL_WIDTH_MIN,
  PANEL_PADDING,
  PANEL_WIDTH_MIN_FALLBACK,
} from './constants';
import { clampNumber } from './utils';

function reservedWidth(width: number, collapsed: boolean) {
  return collapsed ? PANEL_PADDING : width + PANEL_PADDING * 2;
}

/**
 * Side panels give way to the center panel when the logical canvas is too
 * narrow for the user's preferred widths (half-screen window, 16:10 laptop:
 * the canvas stays 1:1 down to APP_SCALE_MIN_CANVAS_WIDTH, see
 * shared/lib/appScale.ts): the right panel shrinks first, then the left one,
 * never below their minimum. The preferred widths stay in state and come back
 * as soon as the canvas is wide enough again.
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

interface DashboardLayoutInput {
  viewport: { w: number; h: number };
  panelWidth: number;
  leftPanelWidth: number;
  exporterPanelHeight: number;
  centerPanelHeightOverride: number | null;
  isLeftPanelCollapsed: boolean;
  isCenterPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
}

export function getDashboardLayout({
  viewport,
  panelWidth,
  leftPanelWidth,
  exporterPanelHeight,
  centerPanelHeightOverride,
  isLeftPanelCollapsed,
  isCenterPanelCollapsed,
  isRightPanelCollapsed,
}: DashboardLayoutInput) {
  // Fluid UI density — see src/shared/lib/appScale.ts.
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

  const fittedPanels = fitSidePanelWidths({
    designW,
    leftPanelWidth,
    rightPanelWidth: panelWidth,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
  });
  const leftPanelReservedWidth = reservedWidth(fittedPanels.left, isLeftPanelCollapsed);
  const centerPanelBaseRegionLeft = leftPanelReservedWidth;
  const rightPanelReservedWidth = reservedWidth(fittedPanels.right, isRightPanelCollapsed);
  // Widest each panel may be dragged while the other keeps its width and the
  // center panel keeps CENTER_PANEL_MIN_WIDTH.
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
  // Ensure the top map stage always retains enough vertical clearance for top-level controls
  // (PlaceSearch on top-left and MapViewportControls on top-right) plus a uniform spacing margin.
  const minMapStageClearance = Math.max(
    CENTER_PANEL_MIN_MAP_STAGE,
    Math.round(designH * 0.25),
  );
  const centerPanelMaxAvailableHeight = Math.max(
    0,
    designH - PANEL_PADDING - CENTER_TOOLBAR_HEIGHT - CENTER_PANEL_STACK_GAP - minMapStageClearance,
  );

  const centerPanelMaxHeight = Math.max(
    CENTER_PANEL_MIN_HEIGHT,
    Math.min(
      centerPanelMaxAvailableHeight,
      Math.round(centerPanelAvailableHeight * CENTER_PANEL_MAX_HEIGHT_RATIO),
    ),
  );
  const centerPanelMinHeight = Math.min(
    centerPanelMaxHeight,
    CENTER_PANEL_MIN_HEIGHT,
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
