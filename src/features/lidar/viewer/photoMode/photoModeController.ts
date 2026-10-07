// ============================================
// Photo mode — glue between the panel, the renderer and the render loop
// ============================================
//
// Turning the mode on raises the still-view quality (full density, more
// accumulated frames, a denser still selection) and hands the frame over
// to the WebGPU photo renderer; turning it off restores the previous
// settings. Settings changes are resolved here into what the renderer
// draws: the real sun at the scene for the chosen local date and time, the
// cloud layer of the chosen scene, haze and exposure.

import type { AdaptivePointBudget } from '../lod/lodBudget';
import { PHOTO_REST_SAMPLES, PHOTO_REST_TARGET_MS, REST_SAMPLES, type RestRefinement } from '../lod/restRefinement';
import { photoSunAt, type SunSite } from './lib/sunDirection';
import { resolveCloudLayer } from './lib/cloudPresets';
import { writePhotoPreferences } from './lib/photoPreferences';
import type { PhotoCasterSource, PhotoModeRenderer, PhotoSceneInfo } from './renderer/types';
import type { PhotoCaptureStatus, PhotoModeState } from './types';

/** GPU time aimed at for a still frame outside the photo mode (RestRefinement's default). */
const DEFAULT_REST_TARGET_MS = 50;
/** Longest wait for the still image before capturing anyway (ms). */
const CAPTURE_WAIT_MS = 60_000;
const HIDE_UI_ATTRIBUTE = 'data-rv-photo-hide-ui';

export interface PhotoModeControllerOptions {
  photo: PhotoModeRenderer;
  site: SunSite;
  scene: PhotoSceneInfo;
  casters: PhotoCasterSource;
  restRefinement: RestRefinement;
  pointBudget: AdaptivePointBudget;
  /** File name stem of the captures (tile). */
  captureName: string;
  /** Something visible changed: the still image restarts. */
  requestRender: () => void;
  /** One more frame without restarting the still image (clouds, capture). */
  requestFrame: () => void;
  /** The mode was turned on or off (canvas resolution, stats). */
  onActiveChange?: (active: boolean) => void;
}

export class PhotoModeController {
  private readonly options: PhotoModeControllerOptions;
  private state: PhotoModeState | null = null;
  private savedUserScale = 1;
  private captureStatus: PhotoCaptureStatus = { busy: false, done: 0, total: PHOTO_REST_SAMPLES, error: null };
  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  constructor(options: PhotoModeControllerOptions) {
    this.options = options;
  }

  get active(): boolean {
    return this.options.photo.active;
  }

  /** Panel state → renderer. */
  apply(state: PhotoModeState): void {
    const { photo, restRefinement, pointBudget } = this.options;
    if (state.enabled !== photo.active) {
      if (state.enabled) {
        this.savedUserScale = pointBudget.userScale;
        pointBudget.userScale = 1;
        restRefinement.setQuality(PHOTO_REST_SAMPLES, PHOTO_REST_TARGET_MS);
        photo.setScene(this.options.scene);
        photo.setCasterSource(this.options.casters);
        photo.setActive(true);
      } else {
        photo.setActive(false);
        pointBudget.userScale = this.savedUserScale;
        restRefinement.setQuality(REST_SAMPLES, DEFAULT_REST_TARGET_MS);
        this.setInterfaceHidden(false);
      }
      this.options.onActiveChange?.(state.enabled);
    }
    if (state.enabled) {
      const sun = photoSunAt(this.options.site, state.date, state.time);
      const scene = this.options.scene;
      const cloud = resolveCloudLayer(state, { minAltM: scene.minAltitudeM, maxAltM: scene.maxAltitudeM });
      photo.setSettings({
        sunDirection: sun.direction,
        cloud: state.clouds === 'clear' ? { ...cloud, coverage: 0 } : cloud,
        haze: Math.max(0, Math.min(1, state.haze / 100)),
        exposureEv: state.exposureEv,
      });
    }
    this.state = state;
    writePhotoPreferences({
      clouds: state.clouds,
      coverage: state.coverage,
      cloudBaseOffsetM: state.cloudBaseOffsetM,
      haze: state.haze,
      exposureEv: state.exposureEv,
    });
    this.options.requestRender();
  }

  // ── Capture ──────────────────────────────────────────────────────────

  getCaptureStatus = (): PhotoCaptureStatus => this.captureStatus;

  subscribeCapture = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setCaptureStatus(status: PhotoCaptureStatus): void {
    const s = this.captureStatus;
    if (status.busy === s.busy && status.done === s.done && status.total === s.total && status.error === s.error) return;
    this.captureStatus = status;
    for (const listener of this.listeners) listener();
  }

  /** Waits for the still image to be final, then downloads it as a PNG. */
  async capture(): Promise<void> {
    if (this.captureStatus.busy || !this.active) return;
    const { restRefinement, photo } = this.options;
    // Points and clouds converge side by side: the progress shows the slower of the two.
    const progress = (): { done: number; total: number } => {
      const sceneTotal = restRefinement.samples;
      const sceneDone = restRefinement.phase === 'done' ? sceneTotal : restRefinement.phase === 'accumulate' ? restRefinement.sample : 0;
      const clouds = photo.cloudProgress();
      return sceneDone / sceneTotal <= clouds.done / clouds.total ? { done: sceneDone, total: sceneTotal } : clouds;
    };
    let { total } = progress();
    this.setCaptureStatus({ busy: true, done: 0, total, error: null });
    let error: string | null = null;
    try {
      await new Promise<void>((resolve) => {
        const started = performance.now();
        const check = () => {
          if (this.destroyed || !this.active) {
            resolve();
            return;
          }
          const current = progress();
          total = current.total;
          this.setCaptureStatus({ busy: true, done: current.done, total, error: null });
          // The clouds converge over their own still frames (often longer than the points).
          if ((restRefinement.phase === 'done' && !photo.needsFrames()) || performance.now() - started > CAPTURE_WAIT_MS) {
            resolve();
            return;
          }
          this.options.requestFrame();
          window.setTimeout(check, 100);
        };
        check();
      });
      if (this.destroyed || !this.active) return;
      const pending = photo.capture();
      this.options.requestFrame();
      const blob = await pending;
      downloadBlob(blob, this.fileName());
    } catch (failure) {
      console.warn('[Photo mode] Capture failed:', failure);
      error = (failure as Error)?.message || String(failure);
    } finally {
      this.setCaptureStatus({ busy: false, done: 0, total, error });
    }
  }

  private fileName(): string {
    const stem = this.options.captureName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'scene';
    const date = this.state?.date ?? new Date().toISOString().slice(0, 10);
    const time = (this.state?.time ?? '12:00').replace(':', 'h');
    return `RedView-LiDAR-${stem}-${date}-${time}.png`;
  }

  // ── Interface hidden for framing ─────────────────────────────────────

  get interfaceHidden(): boolean {
    return document.body.hasAttribute(HIDE_UI_ATTRIBUTE);
  }

  setInterfaceHidden(hidden: boolean): void {
    document.body.toggleAttribute(HIDE_UI_ATTRIBUTE, hidden && this.active);
  }

  destroy(): void {
    this.destroyed = true;
    this.setInterfaceHidden(false);
    this.listeners.clear();
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
