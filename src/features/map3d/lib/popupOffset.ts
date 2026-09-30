import type { PopupOptions } from 'mapbox-gl';

type PopupOffset = NonNullable<PopupOptions['offset']>;

/** Screen-space footprint of a marker around its geographic anchor (px). */
export interface MarkerClearance {
  /** Extent above the anchor. */
  above: number;
  /** Extent below the anchor. */
  below: number;
  /** Half width (left / right of the anchor). */
  side: number;
}

/**
 * Per-anchor Mapbox popup offset that keeps the popup clear of its marker.
 *
 * Mapbox auto-picks the popup anchor (above the point by default, below /
 * beside it near the viewport edges). A single `[x, y]` offset is applied
 * as-is to every anchor, so an offset tuned for one side pushes the popup
 * ONTO the marker as soon as Mapbox flips the anchor. This map offsets each
 * anchor away from the marker by its footprint on that side; corner anchors
 * clear vertically (the popup then extends sideways, away from the marker).
 */
export function buildPopupClearanceOffset(clearance: MarkerClearance, gapPx = 8): PopupOffset {
  const above = Math.round(clearance.above + gapPx);
  const below = Math.round(clearance.below + gapPx);
  const side = Math.round(clearance.side + gapPx);
  return {
    center: [0, 0],
    top: [0, below],
    'top-left': [0, below],
    'top-right': [0, below],
    bottom: [0, -above],
    'bottom-left': [0, -above],
    'bottom-right': [0, -above],
    left: [side, 0],
    right: [-side, 0],
  };
}
