import {
  APP_SCALE_DESIGN_HEIGHT,
  APP_SCALE_DESIGN_WIDTH,
  APP_SCALE_MIN,
  CENTER_PANEL_DEFAULT_HEIGHT_RATIO,
  CENTER_PANEL_MAX_HEIGHT_RATIO,
  CENTER_PANEL_MIN_HEIGHT,
  CENTER_PANEL_MIN_HEIGHT_RATIO,
  CENTER_PANEL_MIN_MAP_STAGE,
  CENTER_PANEL_MIN_WIDTH,
  CENTER_PANEL_RESIZE_HIT_AREA,
  CENTER_PANEL_STACK_GAP,
  CENTER_TOOLBAR_HEIGHT,
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
    ),
    APP_SCALE_MIN,
    1,
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

  const leftPanelReservedWidth = isMapFocusMode || isLeftPanelCollapsed
    ? 0
    : leftPanelWidth + PANEL_PADDING * 2;
  const centerPanelBaseRegionLeft = leftPanelReservedWidth + PANEL_PADDING;
  const rightPanelReservedWidth = isMapFocusMode || isRightPanelCollapsed
    ? 0
    : panelWidth + PANEL_PADDING * 2;
  const centerPanelBaseRegionRight = rightPanelReservedWidth + PANEL_PADDING;
  const centerPanelRegionLeft = leftPanelReservedWidth + PANEL_PADDING;
  const centerPanelRegionRight = rightPanelReservedWidth + PANEL_PADDING;

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
  const centerPanelMinHeight = Math.min(
    centerPanelAvailableHeight,
    Math.max(
      CENTER_PANEL_MIN_HEIGHT,
      Math.round(centerPanelAvailableHeight * CENTER_PANEL_MIN_HEIGHT_RATIO),
    ),
  );
  const centerPanelReservedMapHeight = clampNumber(
    Math.round(designH * 0.16),
    CENTER_PANEL_MIN_MAP_STAGE,
    180,
  );
  const centerPanelMaxHeight = Math.max(
    centerPanelMinHeight,
    Math.min(
      centerPanelAvailableHeight,
      Math.min(
        Math.round(centerPanelAvailableHeight * CENTER_PANEL_MAX_HEIGHT_RATIO),
        centerPanelAvailableHeight - centerPanelReservedMapHeight,
      ),
    ),
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
    centerPanelHeight,
    centerPanelLeft,
    centerPanelTop,
    centerToolbarLeft,
    centerToolbarTop,
    centerPanelResizeHitTop,
  };
}