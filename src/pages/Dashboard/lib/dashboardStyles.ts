import type { CSSProperties } from 'react';
import type { getDashboardLayout } from './layout';
import {
  CENTER_PANEL_RESIZE_HIT_AREA,
  CENTER_TOOLBAR_HEIGHT,
  IMMERSIVE_EASING,
  IMMERSIVE_TRANSITION_MS,
  PANEL_PADDING,
} from './constants';

type DashboardLayout = ReturnType<typeof getDashboardLayout>;

interface DashboardStylesInput {
  layout: DashboardLayout;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  isCenterResizing: boolean;
  isResizing?: boolean;
  isLeftResizing?: boolean;
  panelWidth: number;
  leftPanelWidth: number;
  rightDockWidth: number;
  rightDockOffset: number;
  leftDockWidth: number;
}

export function getDashboardStyles({
  layout,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
  isCenterResizing,
  isResizing = false,
  isLeftResizing = false,
  panelWidth,
  leftPanelWidth,
  rightDockWidth,
  rightDockOffset,
  leftDockWidth,
}: DashboardStylesInput) {
  const isAnyResizing = isResizing || isLeftResizing || isCenterResizing;

  // Shells clip with `overflow: clip`, never `hidden`: a hidden box stays
  // scrollable by code (scrollIntoView, focus()) and would shift its panel.

  const rightPanelStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: rightDockWidth,
    zIndex: 25,
    boxSizing: 'border-box',
    overflow: 'clip',
    transition: isResizing
      ? 'none'
      : `width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const rightPanelContentStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: panelWidth + PANEL_PADDING * 2,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: PANEL_PADDING,
    opacity: isRightPanelCollapsed ? 0 : 1,
    transform: isRightPanelCollapsed
      ? 'translate3d(calc(100% + 16px), 0, 0) scale(0.985)'
      : 'translate3d(0, 0, 0) scale(1)',
    filter: isRightPanelCollapsed ? 'blur(8px) saturate(0.88)' : 'none',
    pointerEvents: isRightPanelCollapsed ? 'none' : 'auto',
    transition: isResizing
      ? 'none'
      : `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity',
  };

  const leftPanelStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: leftDockWidth,
    zIndex: 25,
    boxSizing: 'border-box',
    overflow: 'clip',
    transition: isLeftResizing
      ? 'none'
      : `width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const leftPanelContentStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: leftPanelWidth + PANEL_PADDING * 2,
    padding: PANEL_PADDING,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    opacity: isLeftPanelCollapsed ? 0 : 1,
    transform: isLeftPanelCollapsed
      ? 'translate3d(calc(-100% - 16px), 0, 0) scale(0.985)'
      : 'translate3d(0, 0, 0) scale(1)',
    filter: isLeftPanelCollapsed ? 'blur(8px) saturate(0.88)' : 'none',
    pointerEvents: isLeftPanelCollapsed ? 'none' : 'auto',
    transition: isLeftResizing
      ? 'none'
      : `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity',
  };

  const mapViewportControlsStyle: CSSProperties = {
    position: 'absolute',
    top: PANEL_PADDING,
    right: rightDockOffset,
    zIndex: 30,
    transition: isResizing
      ? 'none'
      : `right ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const rightPrimaryPanelStyle: CSSProperties = {
    height: `${layout.rightPrimaryPanelHeight}px`,
    minHeight: 0,
    display: 'flex',
    transition: isAnyResizing
      ? 'none'
      : 'height 360ms cubic-bezier(0.22, 1, 0.36, 1), transform 360ms cubic-bezier(0.22, 1, 0.36, 1), filter 280ms ease',
    willChange: 'auto',
    transform:
      layout.rightPrimaryPanelHeight > 80 ? 'translateY(0)' : 'translateY(-2px)',
    filter: layout.rightPrimaryPanelHeight > 80 ? 'none' : 'saturate(0.96)',
  };

  const centerToolbarShellStyle: CSSProperties = {
    position: 'absolute',
    top: layout.centerToolbarTop,
    left: layout.centerToolbarLeft,
    width: layout.centerToolbarWidth,
    height: CENTER_TOOLBAR_HEIGHT,
    zIndex: 25,
    overflow: 'clip',
    transition: isAnyResizing
      ? 'none'
      : `top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
    willChange: 'auto',
  };

  const centerResizeHandleStyle: CSSProperties = {
    position: 'absolute',
    top: layout.centerPanelResizeHitTop,
    left: layout.centerPanelLeft,
    width: layout.centerPanelWidth,
    height: CENTER_PANEL_RESIZE_HIT_AREA,
    zIndex: 26,
    cursor: 'row-resize',
    userSelect: 'none',
    touchAction: 'none',
    transition: isAnyResizing
      ? 'none'
      : `top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const centerPanelShellStyle: CSSProperties = {
    position: 'absolute',
    top: layout.centerPanelTop,
    left: layout.centerPanelLeft,
    width: layout.centerPanelWidth,
    height: layout.centerPanelHeight,
    ['--rvc-center-panel-height' as string]: `${layout.centerPanelHeight}px`,
    zIndex: 25,
    overflow: 'clip',
    opacity: layout.centerPanelVisible ? 1 : 0,
    transform: layout.centerPanelVisible
      ? 'translate3d(0, 0, 0) scale(1)'
      : 'translate3d(0, 24px, 0) scale(0.985)',
    filter: layout.centerPanelVisible
      ? 'none'
      : 'blur(10px) saturate(0.88)',
    pointerEvents: layout.centerPanelVisible ? 'auto' : 'none',
    transition: isAnyResizing
      ? 'none'
      : `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
    willChange: 'transform, opacity',
  };

  return {
    rightPanelStyle,
    rightPanelContentStyle,
    leftPanelStyle,
    leftPanelContentStyle,
    mapViewportControlsStyle,
    rightPrimaryPanelStyle,
    centerToolbarShellStyle,
    centerResizeHandleStyle,
    centerPanelShellStyle,
  };
}
