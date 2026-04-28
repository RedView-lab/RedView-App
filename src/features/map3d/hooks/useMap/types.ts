import type { MapViewport } from '../../lib/viewport-persist';
import type { OverlayReloadRegistrar, OverlayStatusReporter } from '../../overlayStatus';

export interface UseMapOptions {
  initialViewport?: MapViewport | null;
  onViewportChange?: (viewport: MapViewport) => void;
  onLoadStatusChange?: OverlayStatusReporter;
  registerReload?: OverlayReloadRegistrar;
  basemapStyleUrl?: string;
}