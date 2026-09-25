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
  isMapFocusMode: boolean;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  isCenterResizing: boolean;
  panelWidth: number;
  leftPanelWidth: number;
  rightDockWidth: number;
  rightDockOffset: number;
  leftDockWidth: number;
}

export function getDashboardStyles({
  layout,
  isMapFocusMode,
  isLeftPanelCollapsed,
  isRightPanelCollapsed,
  isCenterResizing,
  panelWidth,
  leftPanelWidth,
  rightDockWidth,
  rightDockOffset,
  leftDockWidth,
}: DashboardStylesInput) {
  const rightPanelStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: rightDockWidth,
    zIndex: 25,
    boxSizing: 'border-box',
    overflow: 'hidden',
    opacity: isMapFocusMode ? 0 : 1,
    transform: isMapFocusMode
      ? 'translate3d(28px, 0, 0) scale(0.985)'
      : 'translate3d(0, 0, 0) scale(1)',
    filter: isMapFocusMode ? 'blur(10px) saturate(0.88)' : 'blur(0px) saturate(1)',
    pointerEvents: isMapFocusMode ? 'none' : 'auto',
    transition: `width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'width, transform, opacity, filter',
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
    filter: isRightPanelCollapsed ? 'blur(8px) saturate(0.88)' : 'blur(0px) saturate(1)',
    pointerEvents: isRightPanelCollapsed ? 'none' : 'auto',
    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity, filter',
  };

  const leftPanelStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: leftDockWidth,
    zIndex: 25,
    boxSizing: 'border-box',
    overflow: 'hidden',
    opacity: isMapFocusMode ? 0 : 1,
    transform: isMapFocusMode
      ? 'translate3d(-28px, 0, 0) scale(0.985)'
      : 'translate3d(0, 0, 0) scale(1)',
    filter: isMapFocusMode ? 'blur(10px) saturate(0.88)' : 'blur(0px) saturate(1)',
    pointerEvents: isMapFocusMode ? 'none' : 'auto',
    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity, filter',
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
    filter: isLeftPanelCollapsed ? 'blur(8px) saturate(0.88)' : 'blur(0px) saturate(1)',
    pointerEvents: isLeftPanelCollapsed ? 'none' : 'auto',
    transition: `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease`,
    willChange: 'transform, opacity, filter',
  };

  const mapViewportControlsStyle: CSSProperties = {
    position: 'absolute',
    top: PANEL_PADDING,
    right: rightDockOffset,
    zIndex: 30,
    transition: `right ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const rightPrimaryPanelStyle: CSSProperties = {
    height: `${layout.rightPrimaryPanelHeight}px`,
    minHeight: 0,
    display: 'flex',
    transition: 'height 360ms cubic-bezier(0.22, 1, 0.36, 1), transform 360ms cubic-bezier(0.22, 1, 0.36, 1), filter 280ms ease',
    willChange: 'height, transform',
    transform:
      layout.rightPrimaryPanelHeight > 80 ? 'translateY(0)' : 'translateY(-2px)',
    filter: layout.rightPrimaryPanelHeight > 80 ? 'saturate(1)' : 'saturate(0.96)',
  };

  const centerToolbarShellStyle: CSSProperties = {
    position: 'absolute',
    top: layout.centerToolbarTop,
    left: layout.centerToolbarLeft,
    width: layout.centerToolbarWidth,
    height: CENTER_TOOLBAR_HEIGHT,
    zIndex: 25,
    overflow: 'hidden',
    transition: `top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
    willChange: 'top, left, width',
  };

  const centerResizeHandleStyle: CSSProperties = {
    position: 'absolute',
    top: layout.centerPanelResizeHitTop,
    left: layout.centerPanelLeft,
    width: layout.centerPanelWidth,
    height: CENTER_PANEL_RESIZE_HIT_AREA,
    zIndex: 26,
    cursor: isMapFocusMode ? 'default' : 'row-resize',
    userSelect: 'none',
    touchAction: 'none',
    opacity: isMapFocusMode ? 0 : 1,
    pointerEvents: isMapFocusMode ? 'none' : 'auto',
    transition: isCenterResizing
      ? 'none'
      : `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
  };

  const centerPanelShellStyle: CSSProperties = {
    position: 'absolute',
    top: layout.centerPanelTop,
    left: layout.centerPanelLeft,
    width: layout.centerPanelWidth,
    height: layout.centerPanelHeight,
    zIndex: 25,
    overflow: 'hidden',
    opacity: layout.centerPanelVisible ? 1 : 0,
    transform: layout.centerPanelVisible
      ? 'translate3d(0, 0, 0) scale(1)'
      : 'translate3d(0, 24px, 0) scale(0.985)',
    filter: layout.centerPanelVisible
      ? 'blur(0px) saturate(1)'
      : 'blur(10px) saturate(0.88)',
    pointerEvents: layout.centerPanelVisible ? 'auto' : 'none',
    transition: isCenterResizing
      ? 'none'
      : `opacity ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, transform ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, filter ${IMMERSIVE_TRANSITION_MS}ms ease, top ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, left ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}, width ${IMMERSIVE_TRANSITION_MS}ms ${IMMERSIVE_EASING}`,
    willChange: 'transform, opacity, filter, top, left, width',
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
