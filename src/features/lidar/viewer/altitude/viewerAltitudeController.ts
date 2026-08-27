import type { LidarRenderer } from '../renderer';
import type { ViewerAltitudeState } from '../rightPanel/types';

export class ViewerAltitudeController {
  private renderer: LidarRenderer | null;
  private requestRender: () => void;
  private lastState: ViewerAltitudeState | null = null;

  constructor(renderer: LidarRenderer | null, requestRender: () => void) {
    this.renderer = renderer;
    this.requestRender = requestRender;
  }

  setRenderer(renderer: LidarRenderer | null): void {
    this.renderer = renderer;
    if (this.lastState && this.renderer) {
      this.renderer.setAltitudeState(this.lastState);
      this.requestRender();
    }
  }

  handleAltitudeChange(state: ViewerAltitudeState): void {
    this.lastState = state;
    if (!this.renderer) return;
    this.renderer.setAltitudeState(state);
    this.requestRender();
  }

  getState(): ViewerAltitudeState | null {
    return this.lastState;
  }
}
