/**
 * Geometry of the map-viewport legend popover.
 *
 * The legend trigger is the LAST button of the top-right tool stack, so the
 * popover must open *downward* (top edge aligned with the trigger, like the
 * analysis-zone popover next to it). Anchoring it to the trigger bottom made it
 * grow upward and pushed the first slope bands off the top of the viewport on
 * standard laptop heights.
 *
 * Split in two parts so the component only measures and applies:
 *   • `computeLegendPopoverGeometry` — pure vertical placement + height budget.
 *   • `readAppScale` — the `--app-scale` lookup the dashboard portals use.
 */

export type LegendPopoverPlacement = 'below' | 'above';

export interface LegendPopoverGeometryInput {
  /** Trigger top edge, in physical viewport pixels (`getBoundingClientRect().top`). */
  triggerTop: number;
  /** Popover natural content height, in unscaled CSS pixels (`scrollHeight`). */
  naturalHeight: number;
  /** Viewport height in physical pixels (`window.innerHeight`). */
  viewportHeight: number;
  /** Value of `--app-scale` (the dashboard shell renders on a scaled canvas). */
  appScale: number;
}

export interface LegendPopoverGeometry {
  /** `below` = hangs from the trigger top edge (default), `above` = flipped. */
  placement: LegendPopoverPlacement;
  /** Height budget in unscaled CSS pixels; `null` when the natural height fits. */
  maxHeight: number | null;
}

/** Safe-area kept between the popover and the viewport edge, in unscaled px. */
export const LEGEND_POPOVER_VIEWPORT_PADDING = 8;

/**
 * Normalizes a raw `--app-scale` value: anything missing, non-numeric or
 * non-positive falls back to 1 (unscaled canvas).
 */
export function normalizeAppScale(appScale: number): number {
  return Number.isFinite(appScale) && appScale > 0 ? appScale : 1;
}

/** Reads and normalizes the `--app-scale` custom property of an element. */
export function readAppScale(element: Element | null): number {
  if (element == null || typeof window === 'undefined') return 1;
  return normalizeAppScale(
    Number.parseFloat(window.getComputedStyle(element).getPropertyValue('--app-scale')),
  );
}

/**
 * Resolves the placement and the height budget of the legend popover.
 *
 * The dashboard shell is `transform: scale(--app-scale)` from its top-left
 * corner (`Dashboard/index.tsx`), so physical viewport pixels become logical
 * canvas pixels by dividing by the scale — while the popover's `scrollHeight`
 * and CSS lengths are already expressed on that logical canvas.
 */
export function computeLegendPopoverGeometry({
  triggerTop,
  naturalHeight,
  viewportHeight,
  appScale,
}: LegendPopoverGeometryInput): LegendPopoverGeometry {
  const scale = normalizeAppScale(appScale);
  const triggerTopOnCanvas = triggerTop / scale;
  const viewportHeightOnCanvas = viewportHeight / scale;

  const spaceBelow = viewportHeightOnCanvas - triggerTopOnCanvas - LEGEND_POPOVER_VIEWPORT_PADDING;
  const spaceAbove = triggerTopOnCanvas - LEGEND_POPOVER_VIEWPORT_PADDING;

  // Always prefer opening downward (the natural direction for the top-right
  // tool stack); only flip when the content cannot fit below AND the space
  // above is genuinely larger.
  const placement: LegendPopoverPlacement =
    naturalHeight > spaceBelow && spaceAbove > spaceBelow ? 'above' : 'below';

  const available = Math.max(0, placement === 'above' ? spaceAbove : spaceBelow);

  return {
    placement,
    maxHeight: naturalHeight > available ? Math.round(available) : null,
  };
}
