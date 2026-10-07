import type { PlatformProfile } from './types';

// The budget aims at the cadence of the screen, not at a fixed 16.6 ms of
// GPU work: a frame whose passes take 17 ms misses every other vsync on a
// 60 Hz screen (30 fps seen), and the compositor, the panels' blur and the
// streaming also need their share of the interval. The measured cost alone
// cannot tell: a GPU with slack lowers its clock, so its pass time hovers
// around 60–75 % of the interval whatever the load (measured on an
// integrated Radeon). So the cost only bounds the budget (grow below 75 %,
// shrink above 90 % of the interval) and the real cadence (rAF intervals)
// decides near the limit: no growth while frames miss the vsync, and a
// shrink when they keep missing it while the GPU carries a real share of
// the frame. A shrink also caps the growth just below the budget that was
// too much, so the budget does not climb back over the limit every second
// (part of the frame cost is invisible to the timestamps); the cap relaxes
// slowly while the cadence holds, as the view changes.
// Still frames are rendered at full resolution while moving ones may be
// reduced: the budget is sized on moving frames, a still frame may only let
// it grow (it costs at least as much as a moving one) or cut a pathological
// frame.

/** Frames measured before the budget starts adapting. */
const FRAME_WINDOW = 8;
/** A single frame slower than this multiple of the target interval halves the budget at once… */
const EMERGENCY_FRAME_FACTOR = 3;
/** …or than this one for a still frame (full resolution, its cadence does not show). */
const REST_EMERGENCY_FRAME_FACTOR = 6;
const EMERGENCY_COOLDOWN_FRAMES = 6;
/** Frames without a budget change before it is considered settled. */
const SETTLED_FRAMES = 8;
/** Frames at the budget floor and still slow before render settings are lowered. */
const STARVED_FRAMES = 20;
/** Shares of the target interval: the averaged cost shrinks the budget above SLOW, lets it grow below FAST. */
const SLOW_COST_SHARE = 0.9;
const FAST_COST_SHARE = 0.75;
/** Averaged rate of missed vsyncs that counts as slow (when the GPU is loaded) or blocks growth. */
const MISSED_SLOW_RATE = 0.2;
const MISSED_GROW_RATE = 0.05;
/** GPU share of the target interval above which missed vsyncs are blamed on the point count. */
const GPU_LOADED_SHARE = 0.45;
const AVERAGE_ALPHA = 1 / 8;
/** After a shrink, growth stops at this share of the budget that was too much… */
const CEILING_SHARE = 0.95;
/** …and that cap rises by CEILING_RELAX every CEILING_RELAX_FRAMES moving frames without a missed vsync. */
const CEILING_RELAX = 1.01;
const CEILING_RELAX_FRAMES = 60;

/** Cost of one frame and the cadence it ran at. */
export interface BudgetSample {
  /** GPU cost of the draw passes (ms); 0 when not measured yet. */
  gpuMs: number;
  /** JS time of the render loop (ms). */
  cpuMs: number;
  /** Interval since the previous rendered frame (ms); 0 for the first frame of a run. */
  intervalMs: number;
  /** Frame interval aimed at (ms), a multiple of the refresh period (see FrameClock). */
  targetIntervalMs: number;
  /** Display refresh period (ms). */
  refreshMs: number;
  /** Still camera: the frame may let the budget grow, never shrink it (except a pathological frame). */
  rest?: boolean;
}

export interface LodBudgetState {
  pointBudget: number;
  minBudget: number;
  maxBudget: number;
  /**
   * False when the GPU figure is the submit→done latency (no
   * `timestamp-query`): it includes the vsync wait, so only the CPU time
   * and the cadence are trusted.
   */
  preciseGpu: boolean;
  targetIntervalMs: number;
  /** Averaged frame cost (max of GPU and CPU time). */
  avgCostMs: number;
  avgGpuMs: number;
  /** Averaged share of frames that missed at least one vsync beyond the target. */
  missedRate: number;
  framesSeen: number;
  slowFrameCount: number;
  fastFrameCount: number;
  /** Frames left before another emergency cut is allowed (measurements lag by a few frames). */
  emergencyCooldown: number;
  /** Growth cap learnt from the last shrinks (≤ maxBudget). */
  ceiling: number;
  /** Moving frames since the last missed vsync or ceiling step. */
  cleanFrames: number;
}

/** True when the frame came at least half a refresh period later than the target interval. */
function missedTarget(intervalMs: number, targetIntervalMs: number, refreshMs: number): boolean {
  return intervalMs > targetIntervalMs + refreshMs * 0.5;
}

/**
 * Sustained slow frames scale the budget by ×0.9, a longer run of clearly
 * fast ones by ×1.15; a single pathological frame halves it immediately so a
 * weak GPU never stays seconds per frame (Windows TDR → device lost).
 * The first frame of a run (`intervalMs` 0) carries no information.
 */
function updateAdaptiveBudget(state: LodBudgetState, sample: BudgetSample): LodBudgetState {
  const target = sample.targetIntervalMs;
  const cooldown = Math.max(0, state.emergencyCooldown - 1);
  if (sample.intervalMs <= 0) {
    return { ...state, targetIntervalMs: target, emergencyCooldown: cooldown };
  }

  const cost = state.preciseGpu ? Math.max(sample.gpuMs, sample.cpuMs) : sample.cpuMs;
  const avgCostMs = state.avgCostMs + (Math.max(0.1, Math.min(cost, target * 4)) - state.avgCostMs) * AVERAGE_ALPHA;
  const avgGpuMs = state.avgGpuMs + (Math.min(sample.gpuMs, target * 4) - state.avgGpuMs) * AVERAGE_ALPHA;
  const missed = missedTarget(sample.intervalMs, target, sample.refreshMs) ? 1 : 0;
  const missedRate = state.missedRate + (missed - state.missedRate) * AVERAGE_ALPHA;
  const framesSeen = state.framesSeen + 1;
  let { ceiling, cleanFrames } = state;
  if (!sample.rest) {
    cleanFrames = missed ? 0 : cleanFrames + 1;
    if (cleanFrames >= CEILING_RELAX_FRAMES) {
      ceiling = Math.min(state.maxBudget, Math.ceil(ceiling * CEILING_RELAX));
      cleanFrames = 0;
    }
  }
  const measured = { ...state, targetIntervalMs: target, avgCostMs, avgGpuMs, missedRate, framesSeen, ceiling, cleanFrames };

  const emergencyFactor = sample.rest ? REST_EMERGENCY_FRAME_FACTOR : EMERGENCY_FRAME_FACTOR;
  if (cost > target * emergencyFactor && cooldown === 0) {
    return {
      ...measured,
      pointBudget: Math.max(state.minBudget, Math.floor(state.pointBudget * 0.5)),
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: EMERGENCY_COOLDOWN_FRAMES,
    };
  }

  if (framesSeen < FRAME_WINDOW) {
    return { ...measured, emergencyCooldown: cooldown };
  }

  // Asymmetric and slow on purpose: every budget step reshuffles the LOD
  // selection, so it shrinks after a short run of slow frames and only grows
  // after a longer run of clearly fast ones.
  let { pointBudget, slowFrameCount, fastFrameCount } = state;
  if (sample.rest && !isFast(measured)) {
    slowFrameCount = 0;
    fastFrameCount = 0;
  } else if (isSlow(measured)) {
    slowFrameCount++;
    fastFrameCount = 0;
    if (slowFrameCount >= 6) {
      ceiling = Math.max(state.minBudget, Math.min(ceiling, Math.floor(pointBudget * CEILING_SHARE)));
      pointBudget = Math.max(state.minBudget, Math.floor(pointBudget * 0.9));
      slowFrameCount = 0;
    }
  } else if (isFast(measured)) {
    fastFrameCount++;
    slowFrameCount = 0;
    if (fastFrameCount >= 12) {
      pointBudget = Math.max(pointBudget, Math.min(ceiling, Math.floor(pointBudget * 1.15)));
      fastFrameCount = 0;
    }
  } else {
    slowFrameCount = 0;
    fastFrameCount = 0;
  }

  return { ...measured, pointBudget, slowFrameCount, fastFrameCount, emergencyCooldown: cooldown, ceiling };
}

/** Missed vsyncs are blamed on the point count only when the GPU carries a real share of the frame. */
function gpuLoaded(state: LodBudgetState): boolean {
  return !state.preciseGpu || state.avgGpuMs >= state.targetIntervalMs * GPU_LOADED_SHARE;
}

function isSlow(state: LodBudgetState): boolean {
  return state.avgCostMs > state.targetIntervalMs * SLOW_COST_SHARE
    || (state.missedRate > MISSED_SLOW_RATE && gpuLoaded(state));
}

function isFast(state: LodBudgetState): boolean {
  return state.avgCostMs < state.targetIntervalMs * FAST_COST_SHARE && state.missedRate < MISSED_GROW_RATE;
}

/** Point budget driven by measured frame cost and cadence, scaled by the user's density slider. */
export class AdaptivePointBudget {
  private state: LodBudgetState;
  private framesSinceChange = 0;
  private starvedFrames = 0;
  private lastRest = false;
  /** User density slider (0.01–1). */
  userScale = 1;

  constructor(profile: PlatformProfile, options: { preciseGpu: boolean }) {
    const target = 1000 / 60;
    this.state = {
      pointBudget: profile.initialBudget,
      minBudget: Math.min(profile.initialBudget, profile.minBudget),
      maxBudget: profile.maxBudget,
      preciseGpu: options.preciseGpu,
      targetIntervalMs: target,
      avgCostMs: target * SLOW_COST_SHARE,
      avgGpuMs: 0,
      missedRate: 0,
      framesSeen: 0,
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: 0,
      ceiling: profile.maxBudget,
      cleanFrames: 0,
    };
  }

  /** Feeds one rendered frame. */
  sample(sample: BudgetSample): void {
    const rest = sample.rest === true;
    if (rest !== this.lastRest) {
      // Still and moving frames differ in cost (resolution): neither average
      // carries over to the other mode.
      this.lastRest = rest;
      this.state = {
        ...this.state,
        avgCostMs: this.state.targetIntervalMs * (SLOW_COST_SHARE + FAST_COST_SHARE) / 2,
        avgGpuMs: 0,
        missedRate: 0,
        framesSeen: 0,
        slowFrameCount: 0,
        fastFrameCount: 0,
      };
    }
    const next = updateAdaptiveBudget(this.state, sample);
    this.framesSinceChange = next.pointBudget === this.state.pointBudget ? this.framesSinceChange + 1 : 0;
    this.state = next;
    if (sample.intervalMs <= 0 || sample.rest) return;
    const atFloor = next.pointBudget <= next.minBudget;
    const tooSlow = next.avgCostMs > next.targetIntervalMs * 0.95 || (next.missedRate > 0.3 && gpuLoaded(next));
    this.starvedFrames = atFloor && tooSlow ? this.starvedFrames + 1 : 0;
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
    this.state = {
      ...this.state,
      framesSeen: 0,
      missedRate: 0,
      slowFrameCount: 0,
      fastFrameCount: 0,
      emergencyCooldown: EMERGENCY_COOLDOWN_FRAMES,
    };
  }

  /** Points the LOD may draw this frame. */
  get pointBudget(): number {
    return Math.max(1, Math.floor(this.state.pointBudget * this.userScale));
  }

  get rawBudget(): number {
    return this.state.pointBudget;
  }

  /** Read-only view of the controller (stats, benches). */
  getState(): Readonly<LodBudgetState> {
    return this.state;
  }

  /** Cost and cadence leave clear headroom and the ceiling is not reached: the budget would grow. */
  canGrow(): boolean {
    return this.state.pointBudget < this.state.ceiling && isFast(this.state);
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
