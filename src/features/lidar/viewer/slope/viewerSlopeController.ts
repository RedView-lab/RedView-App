import type { LidarRenderer } from '../renderer';
import type { ViewerSlopeState } from '../rightPanel/types';

export class ViewerSlopeController {
  private renderer: LidarRenderer | null;
  private requestRender: () => void;
  private lastState: ViewerSlopeState | null = null;

  constructor(renderer: LidarRenderer | null, requestRender: () => void) {
    this.renderer = renderer;
    this.requestRender = requestRender;
  }

  setRenderer(renderer: LidarRenderer | null): void {
    this.renderer = renderer;
    if (this.lastState && this.renderer) {
      this.renderer.setSlopeState(this.lastState);
      this.requestRender();
    }
  }

  handleSlopeChange(state: ViewerSlopeState): void {
    this.lastState = state;
    if (!this.renderer) return;
    this.renderer.setSlopeState(state);
    this.requestRender();
  }

  getState(): ViewerSlopeState | null {
    return this.lastState;
  }
}
