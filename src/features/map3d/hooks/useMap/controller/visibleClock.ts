/**
 * Timers of the map lifecycle that only count the time the page is visible.
 *
 * A hidden page (background tab, minimised or fully covered window) gets no
 * animation frame: Mapbox does not parse a style (`Style#loadJSON` waits for
 * a frame), requests no tile and never goes idle. A wall-clock watchdog then
 * saw a "stuck" map and fired its recoveries on a map that was simply not
 * being drawn — forced `setStyle` from the URL, DEM source rebuilds, terrain
 * reloads, a false "Carte prête" at 12 s. Every watchdog that judges Mapbox's
 * progress runs on this clock instead: it pauses while the page is hidden and
 * resumes with the time it had left once the page shows again.
 */
export interface VisibleTimer {
  readonly visibleTimer: true;
}

interface TimerEntry extends VisibleTimer {
  fn: () => void;
  /** Visible milliseconds left before the next run. */
  remaining: number;
  /** Period of an interval, null for a one-shot timer. */
  period: number | null;
  startedAt: number;
  native: ReturnType<typeof setTimeout> | null;
}

const entries = new Set<TimerEntry>();
let listening = false;

const isPageHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

function run(entry: TimerEntry): void {
  entry.startedAt = performance.now();
  entry.native = setTimeout(() => fire(entry), entry.remaining);
}

function pause(entry: TimerEntry): void {
  if (!entry.native) return;
  clearTimeout(entry.native);
  entry.native = null;
  entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
}

function fire(entry: TimerEntry): void {
  entry.native = null;
  if (!entries.has(entry)) return;
  if (isPageHidden()) {
    // Fired between the page hiding and its visibilitychange event.
    entry.remaining = 0;
    return;
  }
  if (entry.period === null) {
    entries.delete(entry);
  } else {
    entry.remaining = entry.period;
    run(entry);
  }
  entry.fn();
}

function onVisibilityChange(): void {
  const hidden = isPageHidden();
  for (const entry of entries) {
    if (hidden) pause(entry);
    else if (!entry.native) run(entry);
  }
}

function track(fn: () => void, delayMs: number, period: number | null): VisibleTimer {
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    listening = true;
  }
  const entry: TimerEntry = {
    visibleTimer: true,
    fn,
    remaining: Math.max(0, delayMs),
    period,
    startedAt: 0,
    native: null,
  };
  entries.add(entry);
  if (!isPageHidden()) run(entry);
  return entry;
}

/** `setTimeout` counting visible time only. */
export function setVisibleTimeout(fn: () => void, delayMs: number): VisibleTimer {
  return track(fn, delayMs, null);
}

/** `setInterval` counting visible time only. */
export function setVisibleInterval(fn: () => void, periodMs: number): VisibleTimer {
  return track(fn, periodMs, Math.max(1, periodMs));
}

export function clearVisibleTimer(timer: VisibleTimer | null | undefined): void {
  if (!timer) return;
  const entry = timer as TimerEntry;
  if (!entries.delete(entry)) return;
  if (entry.native) clearTimeout(entry.native);
  entry.native = null;
}
