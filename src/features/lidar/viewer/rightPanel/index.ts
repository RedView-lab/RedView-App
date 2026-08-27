import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LidarViewerRightPanel } from './LidarViewerRightPanel';
import type { ViewerSlopeState, ViewerAltitudeState, SunlightState } from './types';
import type { ViewerRouteController } from '../route/viewerRouteController';

export interface ViewerRightPanelOptions {
  onSlopeChange?: (state: ViewerSlopeState) => void;
  onAltitudeChange?: (state: ViewerAltitudeState) => void;
  onSunlightChange?: (state: SunlightState) => void;
  routeController?: ViewerRouteController;
  centerLon?: number;
  centerLat?: number;
  timeZone?: string;
}

export interface ViewerRightPanelHandle {
  destroy: () => void;
  container: HTMLDivElement;
}

export function createViewerRightPanel(opts: ViewerRightPanelOptions = {}): ViewerRightPanelHandle {
  const existing = document.getElementById('viewer-right-panel');
  if (existing instanceof HTMLDivElement) {
    existing.remove();
  }

  const container = document.createElement('div');
  container.id = 'viewer-right-panel';
  container.className = 'lidar-viewer-right-panel-host';
  document.body.appendChild(container);

  const root: Root = createRoot(container);
  root.render(
    React.createElement(LidarViewerRightPanel, {
      onSlopeChange: opts.onSlopeChange,
      onAltitudeChange: opts.onAltitudeChange,
      onSunlightChange: opts.onSunlightChange,
      routeController: opts.routeController,
      centerLon: opts.centerLon,
      centerLat: opts.centerLat,
      timeZone: opts.timeZone,
    }),
  );

  return {
    container,
    destroy() {
      try {
        root.unmount();
      } catch (err) {
        console.warn('[ViewerRightPanel] Error during unmount:', err);
      }
      container.remove();
    },
  };
}

export { LidarViewerRightPanel };
export type { ViewerSlopeState, ViewerAltitudeState, SunlightState };
