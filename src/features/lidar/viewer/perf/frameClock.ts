// ============================================
// Real frame cadence of the viewer (rAF intervals)
// ============================================
//
// GPU timestamps only measure the passes of a frame. What the user sees also
// depends on the vsync, the compositor and the main thread: on a 60 Hz
// screen a frame of 17 ms of GPU work misses every other vsync and the
// viewer runs at 30 fps. This clock measures the interval between
// consecutive rendered frames while the viewer renders continuously, and
// estimates the display refresh period from the shortest of them.

/** Display refresh rates (Hz) the period estimate snaps to. */
const COMMON_REFRESH_HZ = [60, 75, 90, 100, 120, 144, 165, 180, 240];
const SNAP_TOLERANCE = 0.08;
/** Intervals of the cadence window (≈ 1 s at 60 Hz). */
const WINDOW = 60;
/** Intervals kept for the refresh estimate. */
const HISTORY = 300;
const REFRESH_MIN_SAMPLES = 30;
/** Slowest display assumed: a GPU that never reaches the vsync must not pass for a 30 Hz screen. */
const MAX_REFRESH_MS = 1000 / 60;
const MIN_REFRESH_MS = 1000 / 240;
/** Shortest frame interval aimed at (≈ 90 fps): faster screens get a multiple of their period. */
const MIN_TARGET_INTERVAL_MS = 11;
/** An interval longer than this multiple of the refresh period missed at least one vsync. */
const MISSED_FACTOR = 1.5;
/** Longer gaps are pauses (tab switch, debugger, long task), not frames. */
const MAX_INTERVAL_MS = 1000;

export interface FrameCadence {
  /** Frames per second over the recent window (0 before two continuous frames). */
  fps: number;
  p50Ms: number;
  p95Ms: number;
  /** Share of the recent intervals that missed at least one vsync. */
  missedRatio: number;
  samples: number;
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index]!;
}

/** Snaps a measured period to a common refresh rate when it is close to one. */
function snapRefreshPeriod(ms: number): number {
  for (const hz of COMMON_REFRESH_HZ) {
    const period = 1000 / hz;
    if (Math.abs(ms - period) <= period * SNAP_TOLERANCE) return period;
  }
  return ms;
}

/** Shortest multiple of the refresh period that is at least `MIN_TARGET_INTERVAL_MS`. */
function targetIntervalFor(refreshMs: number): number {
  return refreshMs * Math.max(1, Math.ceil(MIN_TARGET_INTERVAL_MS / refreshMs - 1e-6));
}

export class FrameClock {
  private lastTime = -1;
  private readonly window = new Float64Array(WINDOW);
  private windowCount = 0;
  private windowNext = 0;
  private readonly history = new Float64Array(HISTORY);
  private historyCount = 0;
  private historyNext = 0;
  private sinceRefreshUpdate = 0;
  private refreshMs = MAX_REFRESH_MS;
  private cadence: FrameCadence | null = null;
  /**
   * Interval before the last frame of the run, long ones included (0 for
   * the first frame). Within a continuous run a long gap is a slow frame,
   * not a pause: the cost of still frames when the GPU is not timed.
   */
  lastIntervalMs = 0;

  /**
   * A frame is rendered at rAF time `now` (ms). Returns the interval since
   * the previous one, or 0 for the first frame of a run.
   */
  frame(now: number): number {
    let interval = 0;
    this.lastIntervalMs = 0;
    if (this.lastTime >= 0) {
      interval = now - this.lastTime;
      this.lastIntervalMs = Math.max(0, interval);
      if (interval > 0 && interval < MAX_INTERVAL_MS) this.push(interval);
      else interval = 0;
    }
    this.lastTime = now;
    return interval;
  }

  /** Rendering stopped (idle, hidden tab): the next frame starts a new run. */
  pause(): void {
    this.lastTime = -1;
  }

  /** Estimated display refresh period (ms), 60 Hz until measured. */
  getRefreshMs(): number {
    return this.refreshMs;
  }

  /** Frame interval the viewer aims at: 60 fps on 60/120 Hz, 72 fps on 144 Hz… */
  getTargetIntervalMs(): number {
    return targetIntervalFor(this.refreshMs);
  }

  /** Cadence of the last continuous frames (kept while the viewer idles). */
  getCadence(): FrameCadence {
    if (this.cadence) return this.cadence;
    const count = this.windowCount;
    const sorted = this.window.slice(0, count).sort();
    let sum = 0;
    let missed = 0;
    for (let i = 0; i < count; i++) {
      sum += sorted[i]!;
      if (sorted[i]! > this.refreshMs * MISSED_FACTOR) missed++;
    }
    this.cadence = {
      fps: count > 0 ? Math.round((1000 * count) / sum) : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      missedRatio: count > 0 ? missed / count : 0,
      samples: count,
    };
    return this.cadence;
  }

  private push(interval: number): void {
    this.window[this.windowNext] = interval;
    this.windowNext = (this.windowNext + 1) % WINDOW;
    this.windowCount = Math.min(WINDOW, this.windowCount + 1);
    this.history[this.historyNext] = interval;
    this.historyNext = (this.historyNext + 1) % HISTORY;
    this.historyCount = Math.min(HISTORY, this.historyCount + 1);
    this.cadence = null;
    if (++this.sinceRefreshUpdate >= REFRESH_MIN_SAMPLES && this.historyCount >= REFRESH_MIN_SAMPLES) {
      this.sinceRefreshUpdate = 0;
      // Frames that met the vsync are the shortest ones: a low percentile
      // ignores the odd early callback but not a run of missed vsyncs.
      const sorted = this.history.slice(0, this.historyCount).sort();
      const estimate = snapRefreshPeriod(percentile(sorted, 0.1));
      this.refreshMs = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, estimate));
    }
  }
}
