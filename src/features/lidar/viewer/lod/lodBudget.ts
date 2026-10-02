import type { PlatformProfile } from './types';

/** Rolling frame window before the budget starts adapting. */
const FRAME_WINDOW = 8;
/** A single frame slower than this multiple of the target halves the budget at once. */
const EMERGENCY_FRAME_FACTOR = 3;
const EMERGENCY_COOLDOWN_FRAMES = 6;
/** Frames without a budget change before it is considered settled. */
const SETTLED_FRAMES = 8;
/** Frames at the budget floor and still slow before render settings are lowered. */
const STARVED_FRAMES = 20;

export interface LodBudgetState {
  pointBudget: number;
  minBudget: number;
  maxBudget: number;
  targetFrameMs: number;
  avgFrameMs: number;
  framesSeen: number;
  slowFrameCount: number;
  fastFrameCount: number;
  /** Frames left before another emergency cut is allowed (measurements lag by a few frames). */
  emergencyCooldown: number;
}

/**
 * `deltaMs` is the measured frame cost (GPU time when available, see
 * `LidarRenderer.getGpuFrameMs`). Sustained slow/fast frames scale the budget
 * by ×0.9/×1.2; a single pathological frame halves it immediately so a weak
 * GPU never stays seconds per frame (Windows TDR → device lost).
 */
export function updateAdaptiveBudget(state: LodBudgetState, deltaMs: number): LodBudgetState & { fps: number } {
  const sample = Math.max(1, Math.min(deltaMs, state.targetFrameMs * 4));
  const alpha = 1 / 8;
  const avgFrameMs = state.avgFrameMs * (1 - alpha) + sample * alpha;
  const framesSeen = state.framesSeen + 1;
  const cooldown = Math.max(0, state.emergencyCooldown - 1);
  const fps = Math.round(1000 / Math.max(avgFrameMs, 1));

  if (deltaMs > state.targetFrameMs * EMERGENCY_FRAME_FACTOR && cooldown === 0) {
    return {
      ...state,
      pointBudget: Math.max(state.minBudget, Math.floor(state.pointBudget * 0.5)),
      avgFrameMs,
      framesSeen,
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: EMERGENCY_COOLDOWN_FRAMES,
      fps,
    };
  }

  if (framesSeen < FRAME_WINDOW) {
    return { ...state, avgFrameMs, framesSeen, emergencyCooldown: cooldown, fps };
  }

  // Asymmetric and slow on purpose: every budget step reshuffles the LOD
  // selection, so it shrinks after a short run of slow frames and only grows
  // after a longer run of clearly fast ones.
  let { pointBudget, slowFrameCount, fastFrameCount } = state;
  if (avgFrameMs > state.targetFrameMs * 1.15) {
    slowFrameCount++;
    fastFrameCount = 0;
    if (slowFrameCount >= 6) {
      pointBudget = Math.max(state.minBudget, Math.floor(pointBudget * 0.9));
      slowFrameCount = 0;
    }
  } else if (avgFrameMs < state.targetFrameMs * 0.75) {
    fastFrameCount++;
    slowFrameCount = 0;
    if (fastFrameCount >= 12) {
      pointBudget = Math.min(state.maxBudget, Math.floor(pointBudget * 1.15));
      fastFrameCount = 0;
    }
  } else {
    slowFrameCount = 0;
    fastFrameCount = 0;
  }

  return { ...state, pointBudget, avgFrameMs, framesSeen, slowFrameCount, fastFrameCount, emergencyCooldown: cooldown, fps };
}

/** Point budget driven by measured frame cost, scaled by the user's density slider. */
export class AdaptivePointBudget {
  private state: LodBudgetState;
  private framesSinceChange = 0;
  private starvedFrames = 0;
  /** User density slider (0.01–1). */
  userScale = 1;
  fps = 60;

  constructor(profile: PlatformProfile) {
    this.state = {
      pointBudget: profile.initialBudget,
      minBudget: Math.min(profile.initialBudget, profile.minBudget),
      maxBudget: profile.maxBudget,
      targetFrameMs: profile.targetFrameMs,
      avgFrameMs: profile.targetFrameMs,
      framesSeen: 0,
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: 0,
    };
  }

  /** Feeds the cost of one frame (ms). */
  sample(frameMs: number): void {
    const next = updateAdaptiveBudget(this.state, frameMs);
    this.framesSinceChange = next.pointBudget === this.state.pointBudget ? this.framesSinceChange + 1 : 0;
    this.fps = next.fps;
    this.state = next;
    const atFloor = next.pointBudget <= next.minBudget;
    this.starvedFrames = atFloor && next.avgFrameMs > next.targetFrameMs * 1.3 ? this.starvedFrames + 1 : 0;
  }

  /**
   * The budget sits at its floor and frames are still clearly too slow:
   * fewer points cannot help any more, the render settings must get cheaper.
   */
  isStarved(): boolean {
    return this.starvedFrames >= STARVED_FRAMES;
  }

  /** Restarts the measurements after a render-settings change. */
  resetMeasurements(): void {
    this.starvedFrames = 0;
    this.state = { ...this.state, framesSeen: 0, slowFrameCount: 0, fastFrameCount: 0, emergencyCooldown: EMERGENCY_COOLDOWN_FRAMES };
  }

  /** Points the LOD may draw this frame. */
  get pointBudget(): number {
    return Math.max(1, Math.floor(this.state.pointBudget * this.userScale));
  }

  get rawBudget(): number {
    return this.state.pointBudget;
  }

  /** GPU time leaves clear headroom and the ceiling is not reached: the budget would grow. */
  canGrow(): boolean {
    return this.state.pointBudget < this.state.maxBudget && this.state.avgFrameMs < this.state.targetFrameMs * 0.75;
  }

  /**
   * No recent change and no pending growth. The render loop keeps drawing
   * while this is false, otherwise a still camera would freeze the budget
   * (growth needs a run of measured fast frames).
   */
  isSettled(): boolean {
    return this.framesSinceChange >= SETTLED_FRAMES && !this.canGrow();
  }
}
