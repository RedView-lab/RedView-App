/**
 * UI density (fluid canvas scale), shared by the dashboard and the LiDAR viewer.
 *
 * The UI is laid out in LOGICAL pixels (type scale: shared/styles/typography.css)
 * and rendered at `appScale` screen pixels per logical pixel, so text and
 * controls keep a comfortable physical size from 13" laptops to ultrawides:
 *
 * - Below the minimum canvas (MIN_CANVAS): the scale tracks the contain-fit
 *   ratio, so the logical canvas never gets smaller than what the dashboard
 *   layout needs, down to a readability floor (MIN).
 * - Between the minimum canvas and the design reference: 1:1, no scaling; the
 *   side panels give way to the center panel instead (`fitSidePanelWidths`,
 *   pages/Dashboard/lib/layout.ts). A half-screen window or a 16:10 laptop
 *   keeps full-size text rather than shrinking the whole UI.
 * - Above the design reference (DESIGN): the scale keeps growing gently
 *   (GROW_FACTOR of the surplus) up to MAX — 1440p and ultrawide monitors gain
 *   text comfort without turning into a giant zoom. Extra width on ultrawides
 *   goes to the map, not to bigger text (the fit uses the limiting axis).
 *
 * Shrinking is a last resort: `transform: scale()` below 1 renders glyphs
 * smaller and softer, badly so on non-HiDPI screens (at 0.6 a 13 px label ends
 * up ~8 px, unreadable).
 */
/** Readability floor: 13 px labels stay ≥ ~10 px on screen, 11 px captions ≥ ~8 px. */
export const APP_SCALE_MIN = 0.75;
/**
 * Smallest logical canvas the dashboard layout fits in (pages/Dashboard/lib/
 * constants.ts): both side panels at their minimum width (2 × (360 + 2 × 12))
 * plus the center panel minimum (420) ≈ 1188 px; toolbar (12 + 48 + 12) +
 * center panel minimum (390) + map stage clearance (384) ≈ 846 px.
 */
export const APP_SCALE_MIN_CANVAS_WIDTH = 1200;
export const APP_SCALE_MIN_CANVAS_HEIGHT = 860;
export const APP_SCALE_DESIGN_WIDTH = 1920;
export const APP_SCALE_DESIGN_HEIGHT = 1080;
export const APP_SCALE_MAX = 1.12;
/** Fraction of the viewport surplus (above the design reference) applied to the scale. */
export const APP_SCALE_GROW_FACTOR = 0.55;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function computeAppScale(viewport: { w: number; h: number }): number {
  const fitMinCanvas = Math.min(
    viewport.w / APP_SCALE_MIN_CANVAS_WIDTH,
    viewport.h / APP_SCALE_MIN_CANVAS_HEIGHT,
  );
  if (!Number.isFinite(fitMinCanvas)) return 1;
  if (fitMinCanvas < 1) return clamp(fitMinCanvas, APP_SCALE_MIN, 1);

  const fitDesign = Math.min(
    viewport.w / APP_SCALE_DESIGN_WIDTH,
    viewport.h / APP_SCALE_DESIGN_HEIGHT,
  );
  if (fitDesign > 1) {
    return clamp(1 + (fitDesign - 1) * APP_SCALE_GROW_FACTOR, 1, APP_SCALE_MAX);
  }
  return 1;
}

/** `--app-scale` currently published on :root (see `syncRootAppScale`). */
export function readRootAppScale(): number {
  if (typeof document === 'undefined') return 1;
  const raw = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--app-scale'),
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Publishes `computeAppScale(window)` as `--app-scale` on :root and keeps it
 * in sync with window resizes. For pages without the dashboard canvas (LiDAR
 * viewer), whose floating panels apply it with `zoom: var(--app-scale)`.
 * Returns a cleanup function.
 */
export function syncRootAppScale(): () => void {
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty(
      '--app-scale',
      String(computeAppScale({ w: window.innerWidth, h: window.innerHeight })),
    );
  };
  apply();
  window.addEventListener('resize', apply, { passive: true });
  return () => {
    window.removeEventListener('resize', apply);
    root.style.removeProperty('--app-scale');
  };
}
