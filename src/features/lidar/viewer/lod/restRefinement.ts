// ============================================
// Still-camera quality: refinement budget + progressive anti-aliasing
// ============================================
//
// The point budget is sized for moving frames (a vsync each). Once the
// camera stops, nothing has to be ready within 16 ms any more, so the still
// image is refined in two steps:
//  1. refine: the budget grows to what the GPU draws in about
//     REST_TARGET_MS per frame (measured: the cost of the complete still
//     selection is read, then the budget is scaled towards the target, at
//     most MAX_ADJUSTMENTS times; bounded by the platform's rest ceiling).
//     The deeper nodes stream in and the far field reaches the on-screen
//     density of the foreground. The learnt budget carries over to the next
//     still views;
//  2. accumulate: with the selection complete, REST_SAMPLES frames are
//     rendered with sub-pixel offsets (Halton 2,3) and averaged in linear
//     light (renderer `accumulate`): every pixel ends up as the mean of what
//     it covers, as 16× supersampling would give: no shimmering sub-pixel
//     points far away, smooth edges, no jagged sprite discs.
// Then the render loop goes idle. Any camera move drops back to the moving
// budget at once (its selection is a prefix of the still one, so already
// resident).

/** Frames averaged by the progressive anti-aliasing. */
export const REST_SAMPLES = 16;
/** GPU time aimed at for a still frame (a few vsyncs: nothing moves). */
const REST_TARGET_MS = 50;
/** The budget grows while a complete still frame costs less than this share of the target… */
const GROW_BELOW = 0.6;
/** …and shrinks above this one. */
const SHRINK_ABOVE = 1.35;
/** Largest growth of one adjustment. */
const MAX_GROWTH = 2.5;
/** Frames of an unchanged, fully loaded selection before its cost is read (the GPU timer is smoothed). */
const MEASURE_FRAMES = 6;
const MAX_ADJUSTMENTS = 4;
/** First still budget, as a multiple of the moving one, before any measurement. */
const INITIAL_FACTOR = 3;
/** A complete still frame this slow stops the refinement or the accumulation at once (sluggish input otherwise). */
const REST_ABORT_MS = 200;

export type RestPhase = 'moving' | 'refine' | 'accumulate' | 'done';

/** Radical inverse of `index` in `base` (Halton sequence), in [0, 1). */
function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/** Cost of the still frame just rendered. */
export interface RestFrameSample {
  /** Every node of the selection is drawn (no pending load). */
  lodIdle: boolean;
  /** Smoothed GPU cost of the frames (ms); frame interval when the GPU is not timed. */
  gpuMs: number;
  /** The budget cut the selection (more points would be drawn with a larger one). */
  budgetLimited: boolean;
}

export class RestRefinement {
  phase: RestPhase = 'moving';
  /** Index of the next accumulated frame (0 = plain frame, replaces the history). */
  sample = 0;
  /** Learnt still budget (points, before the density slider); 0 until the first still view. */
  private restBudget = 0;
  private stableFrames = 0;
  private adjustments = 0;
  private readonly enabled: boolean;

  /** @param enabled false keeps every frame at the moving budget, without accumulation (pinned-budget benches). */
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** The camera moves: moving budget, no accumulation. */
  setMoving(): void {
    this.phase = 'moving';
    this.sample = 0;
  }

  /** Still camera and the moving budget has settled with its selection drawn: start refining. */
  startRefine(): void {
    if (this.phase !== 'moving') return;
    this.enterRefine();
  }

  /**
   * Something on screen changed (overlay, colours, density, new node…): the
   * averaged history is stale. The still selection is checked again (it may
   * need loads) before a new accumulation starts.
   */
  invalidate(): void {
    if (this.phase === 'accumulate' || this.phase === 'done') this.enterRefine();
  }

  private enterRefine(): void {
    this.phase = this.enabled ? 'refine' : 'done';
    this.sample = 0;
    this.stableFrames = 0;
    this.adjustments = 0;
  }

  /**
   * Still-frame budget (points, before the density slider) from the raw
   * moving one, within [moving budget, rest ceiling].
   */
  budget(movingBudget: number, restCeiling: number): number {
    if (this.phase === 'moving' || !this.enabled) return movingBudget;
    if (this.restBudget <= 0) this.restBudget = movingBudget * INITIAL_FACTOR;
    this.restBudget = Math.max(movingBudget, Math.min(restCeiling, this.restBudget));
    return Math.round(this.restBudget);
  }

  /**
   * After a refine frame: once the selection has been complete for a few
   * frames, its cost scales the budget towards REST_TARGET_MS (more loads
   * follow), or the accumulation starts.
   */
  onRefineFrame(frame: RestFrameSample, movingBudget: number, restCeiling: number): void {
    if (this.phase !== 'refine') return;
    if (!frame.lodIdle) {
      this.stableFrames = 0;
      return;
    }
    if (frame.gpuMs > REST_ABORT_MS) {
      // A complete still frame already this slow (software rasteriser, weak
      // GPU): refining and averaging would keep the view sluggish for many
      // seconds. This frame is the final image; the next still views start
      // from half the budget.
      this.restBudget = Math.max(movingBudget, this.restBudget * 0.5);
      this.phase = 'done';
      return;
    }
    if (++this.stableFrames < MEASURE_FRAMES) return;
    this.stableFrames = 0;
    if (frame.gpuMs > 0 && this.adjustments < MAX_ADJUSTMENTS) {
      const target = REST_TARGET_MS;
      if (frame.budgetLimited && frame.gpuMs < target * GROW_BELOW && this.restBudget < restCeiling) {
        this.restBudget = Math.min(restCeiling, this.restBudget * Math.min(MAX_GROWTH, (target * 0.85) / frame.gpuMs));
        this.adjustments++;
        return;
      }
      if (frame.gpuMs > target * SHRINK_ABOVE && this.restBudget > movingBudget) {
        this.restBudget = Math.max(movingBudget, this.restBudget * Math.max(0.5, target / frame.gpuMs));
        this.adjustments++;
        return;
      }
    }
    this.phase = 'accumulate';
    this.sample = 0;
  }

  /** Sub-pixel offset (canvas px, within ±0.5) of the frame about to be accumulated. */
  jitter(): [number, number] {
    if (this.phase !== 'accumulate' || this.sample === 0) return [0, 0];
    return [halton(this.sample, 2) - 0.5, halton(this.sample, 3) - 0.5];
  }

  /** After an accumulated frame (`gpuMs` as in RestFrameSample). */
  onAccumulatedFrame(gpuMs: number, movingBudget: number): void {
    if (this.phase !== 'accumulate') return;
    if (gpuMs > REST_ABORT_MS) {
      this.restBudget = Math.max(movingBudget, this.restBudget * 0.5);
      this.phase = 'done';
      return;
    }
    this.sample++;
    if (this.sample >= REST_SAMPLES) this.phase = 'done';
  }

  /** Still frames left to render before the image is final. */
  get pending(): boolean {
    return this.phase === 'refine' || this.phase === 'accumulate';
  }
}
