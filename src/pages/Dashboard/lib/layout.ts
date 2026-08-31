import {
  APP_SCALE_DESIGN_HEIGHT,
  APP_SCALE_DESIGN_WIDTH,
  APP_SCALE_MIN,
  CENTER_PANEL_DEFAULT_HEIGHT_RATIO,
  CENTER_PANEL_MAX_HEIGHT_RATIO,
  CENTER_PANEL_MIN_HEIGHT,
  CENTER_PANEL_MIN_MAP_STAGE,
  CENTER_PANEL_MIN_WIDTH,
  CENTER_PANEL_RESIZE_HIT_AREA,
  CENTER_PANEL_STACK_GAP,
  CENTER_TOOLBAR_HEIGHT,
  COLLAPSED_DRAWER_CLEARANCE,
  PANEL_PADDING,
} from './constants';
import { clampNumber } from './utils';

interface DashboardLayoutInput {
  viewport: { w: number; h: number };
  panelWidth: number;
  leftPanelWidth: number;
  exporterPanelHeight: number;
  centerPanelHeightOverride: number | null;
  isMapFocusMode: boolean;
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
  isMapFocusMode,
  isLeftPanelCollapsed,
  isCenterPanelCollapsed,
  isRightPanelCollapsed,
}: DashboardLayoutInput) {
  const appScale = clampNumber(
    Math.min(
      viewport.w / APP_SCALE_DESIGN_WIDTH,
      viewport.h / APP_SCALE_DESIGN_HEIGHT,
    ) * 0.86,
    APP_SCALE_MIN,
    0.86,
  );
  const scaledViewportWidth = viewport.w / appScale;
  const scaledViewportHeight = viewport.h / appScale;
  const designW = scaledViewportWidth;
  const designH = scaledViewportHeight;

  const rightDockContentHeight = Math.max(0, designH - PANEL_PADDING * 2);
  const rightPrimaryPanelHeight = Math.max(
    0,
    rightDockContentHeight - exporterPanelHeight - PANEL_PADDING,
  );

  const leftPanelReservedWidth = isMapFocusMode
    ? PANEL_PADDING
    : isLeftPanelCollapsed
      ? COLLAPSED_DRAWER_CLEARANCE
      : leftPanelWidth + PANEL_PADDING * 2;
  const centerPanelBaseRegionLeft = leftPanelReservedWidth;
  const rightPanelReservedWidth = isMapFocusMode
    ? PANEL_PADDING
    : isRightPanelCollapsed
      ? COLLAPSED_DRAWER_CLEARANCE
      : panelWidth + PANEL_PADDING * 2;
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
  const centerPanelVisible = centerToolbarVisible && !isMapFocusMode && !isCenterPanelCollapsed;
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
  const centerToolbarLeft = isMapFocusMode
    ? Math.max(PANEL_PADDING, Math.round((designW - centerToolbarWidth) / 2))
    : centerPanelBaseRegionLeft;
  const centerToolbarTop = isMapFocusMode || isCenterPanelCollapsed
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
