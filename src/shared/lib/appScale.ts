import type { CSSProperties } from 'react';

/**
 * UI density (canvas scale), shared by the dashboard and the LiDAR viewer.
 *
 * The UI is laid out in LOGICAL pixels (type scale: shared/styles/typography.css)
 * and rendered at `appScale` CSS pixels per logical pixel.
 *
 * Rule: on a standard-density screen the UI is NEVER shrunk below 1:1. A CSS
 * pixel already carries the user's OS scaling (125 %, 150 %…) and browser
 * zoom; shrinking on top of it gave 8–10 px text, blurry on non-HiDPI screens
 * (half-screen 1080p window, 1366×768 laptop, 1080p laptop at 125–150 %).
 * Small or short windows reflow instead (pages/Dashboard/lib/layout.ts: side
 * panels give way, center panel and map tools compact); browser zoom stays
 * the user's density control.
 *
 * Retina exception (≥ 2 device px per CSS px: MacBook, 4K at 200 %): a text
 * shrunk to 9.5 CSS px is still drawn on 19 device px, sharp. A 13–14"
 * MacBook (≈1440–1512 × 800–870 CSS px) at 1:1 looked oversized and crammed
 * the map/center toolbars onto two rows, so below the design reference the
 * scale follows HIDPI_SHRINK_FACTOR of the deficit, never under HIDPI_MIN
 * (MacBook Air 13" ≈ 0.87, MacBook Pro 14" ≈ 0.89).
 *
 * Above the design reference (DESIGN) the scale grows gently (GROW_FACTOR of
 * the surplus) up to MAX: 1440p and ultrawide monitors gain text comfort
 * without turning into a giant zoom. Extra width on ultrawides goes to the
 * map, not to bigger text (the fit uses the limiting axis).
 *
 * The scale is applied with CSS `zoom` (see `appScaleStyle`): text is laid out
 * and rasterised at its final size, borders snap to device pixels. A
 * `transform: scale()` only resamples the 1:1 rendering, which blurs text.
 */
export const APP_SCALE_DESIGN_WIDTH = 1920;
export const APP_SCALE_DESIGN_HEIGHT = 1080;
export const APP_SCALE_MAX = 1.12;
/** Fraction of the viewport surplus (above the design reference) applied to the scale. */
export const APP_SCALE_GROW_FACTOR = 0.55;
/**
 * Pixel ratio from which the canvas may shrink below 1:1 (Retina). Read with
 * a `resolution` media query: `window.devicePixelRatio` is capped for Mapbox
 * (map3d/hooks/useMap/runtimeProfile.ts) and no longer reports the screen.
 */
const HIDPI_QUERY = '(min-resolution: 1.95dppx)';
/** Fraction of the viewport deficit (below the design reference) applied on Retina. */
export const APP_SCALE_HIDPI_SHRINK_FACTOR = 0.5;
/** Retina floor: the 11 px text floor shows at 9.35 CSS px, 18.7 device px. */
export const APP_SCALE_HIDPI_MIN = 0.85;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export interface AppScaleViewport {
  w: number;
  h: number;
  /** Screen of ≥ 2 device px per CSS px (Retina); false when unknown. */
  hiDpi?: boolean;
}

/** Current window size and pixel density, as `computeAppScale` takes them. */
export function readAppScaleViewport(): AppScaleViewport {
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    hiDpi: window.matchMedia?.(HIDPI_QUERY).matches ?? false,
  };
}

/**
 * Calls `onChange` when the window is resized or crosses the Retina threshold
 * (window moved to a screen of another density fires no `resize`). Returns a
 * cleanup.
 */
export function watchAppScaleViewport(onChange: () => void): () => void {
  const media = window.matchMedia?.(HIDPI_QUERY) ?? null;
  media?.addEventListener('change', onChange);
  window.addEventListener('resize', onChange, { passive: true });
  return () => {
    window.removeEventListener('resize', onChange);
    media?.removeEventListener('change', onChange);
  };
}

export function computeAppScale(viewport: AppScaleViewport): number {
  const fitDesign = Math.min(
    viewport.w / APP_SCALE_DESIGN_WIDTH,
    viewport.h / APP_SCALE_DESIGN_HEIGHT,
  );
  if (!Number.isFinite(fitDesign)) return 1;
  let scale = 1;
  if (fitDesign > 1) {
    scale = clamp(1 + (fitDesign - 1) * APP_SCALE_GROW_FACTOR, 1, APP_SCALE_MAX);
  } else if (viewport.hiDpi) {
    scale = clamp(1 - (1 - fitDesign) * APP_SCALE_HIDPI_SHRINK_FACTOR, APP_SCALE_HIDPI_MIN, 1);
  }
  // Rounded so that layout sizes stay on a short decimal grid.
  return Math.round(scale * 1000) / 1000;
}

let standardZoomSupport: boolean | null = null;

/**
 * True when CSS `zoom` follows the standardised model (Chromium ≥ 128,
 * Firefox ≥ 126): `getBoundingClientRect()` returns zoomed (visual) values
 * and `offsetWidth`/`clientWidth` logical ones, exactly like a
 * `transform: scale()` ancestor, so pointer/rect code (Mapbox, menus, resize
 * handles) works unchanged. Other engines fall back to the transform.
 */
export function supportsStandardZoom(): boolean {
  if (standardZoomSupport != null) return standardZoomSupport;
  if (
    typeof document === 'undefined' ||
    !document.body ||
    typeof CSS === 'undefined' ||
    !CSS.supports?.('zoom', '2')
  ) {
    return false;
  }
  const outer = document.createElement('div');
  outer.style.cssText =
    'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;zoom:2';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:10px;height:10px';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  const rect = inner.getBoundingClientRect();
  standardZoomSupport = Math.abs(rect.width - 20) < 0.5 && inner.offsetWidth === 10;
  outer.remove();
  return standardZoomSupport;
}

/** Style rendering a box (and its subtree) at `scale`, its own position unaffected. */
export function appScaleStyle(scale: number): CSSProperties {
  if (scale === 1) return {};
  if (supportsStandardZoom()) return { zoom: scale };
  return { transform: `scale(${scale})`, transformOrigin: 'top left' };
}

/**
 * Position + scale of a fixed overlay portaled to <body> (outside the
 * dashboard canvas) that must keep the dashboard density. `top`/`left` are
 * viewport px (from `getBoundingClientRect`) of the overlay's top-left corner
 * on screen; the overlay's own sizes stay in logical px.
 *
 * `inScaledLayer`: portaled into a layer already rendered at `scale`
 * (`.rv-app-scaled-layer`); the overlay inherits the scale and its offsets
 * are logical px with either technique.
 */
export function appScaledOverlayStyle(
  {
    top,
    left,
    scale,
  }: {
    top: number;
    left: number;
    scale: number;
  },
  inScaledLayer = false,
): CSSProperties {
  if (scale === 1) return { top, left };
  if (inScaledLayer) return { top: top / scale, left: left / scale };
  // A zoomed box's own offsets are zoomed too: express them in logical px.
  if (supportsStandardZoom()) return { top: top / scale, left: left / scale, zoom: scale };
  return { top, left, transform: `scale(${scale})`, transformOrigin: 'top left' };
}

/** `--app-scale` read on `el` (inherited from the canvas or :root), 1 when absent. */
export function readAppScale(el: Element | null): number {
  if (!el || typeof window === 'undefined') return 1;
  const raw = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('--app-scale'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** `--app-scale` currently published on :root (see `publishRootAppScale`). */
export function readRootAppScale(): number {
  if (typeof document === 'undefined') return 1;
  return readAppScale(document.documentElement);
}

/**
 * Publishes `scale` as `--app-scale` on :root, with `data-rv-scale-mode`
 * (`zoom` | `transform`) so CSS-scaled layers (`.rv-app-scaled-layer`,
 * src/index.css) use the same technique as the JS ones. Returns a cleanup.
 */
export function publishRootAppScale(scale: number): () => void {
  const root = document.documentElement;
  root.style.setProperty('--app-scale', String(scale));
  root.dataset.rvScaleMode = supportsStandardZoom() ? 'zoom' : 'transform';
  return () => {
    root.style.removeProperty('--app-scale');
    delete root.dataset.rvScaleMode;
  };
}

/**
 * Keeps `--app-scale` on :root in sync with `computeAppScale(window)`. For
 * pages without the dashboard canvas (LiDAR viewer), whose floating panels
 * apply it with `zoom: var(--app-scale)`. Returns a cleanup function.
 */
export function syncRootAppScale(): () => void {
  let cleanup = publishRootAppScale(computeAppScale(readAppScaleViewport()));
  const apply = () => {
    cleanup();
    cleanup = publishRootAppScale(computeAppScale(readAppScaleViewport()));
  };
  const stopWatching = watchAppScaleViewport(apply);
  return () => {
    stopWatching();
    cleanup();
  };
}
