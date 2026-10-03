import mapboxgl from 'mapbox-gl';
import { supportsStandardZoom } from '@/shared/lib/appScale';

/**
 * Mapbox GL sized for a container under a CSS `zoom` ancestor.
 *
 * The dashboard is rendered at `appScale` with CSS `zoom` (`appScaleStyle`,
 * shared/lib/appScale.ts): 0.85–0.95 on Retina laptops, up to 1.12 on large
 * screens. Mapbox GL (`Map#_updateContainerDimensions`, checked on 3.21)
 * measures its container with `getBoundingClientRect()` — zoomed px under the
 * standardised `zoom` model — and only divides out a CSS `transform` scale.
 * The transform and the canvas then got the zoomed size, and the canvas was
 * laid out inside the zoomed box, i.e. zoomed twice: at 0.894 (MacBook Pro
 * 14") the 3D map covered 0.894² of its area, a blank band along the right
 * and bottom edges; at 1.117 (1440p) it overflowed and was clipped.
 *
 * The patch divides that measure by the container's effective zoom: the
 * transform, the canvas CSS size and the pointer mapping (`mousePos`:
 * offsetWidth / rect.width, see lib/mapPointer.ts) all use the container's
 * layout px again, like at scale 1, so `map.project()`, `event.point`,
 * markers and popups match the logical canvas the UI is laid out in. The
 * backing store keeps its on-screen density: `devicePixelRatio` already
 * carries the canvas scale (`setDprLayoutScale`, runtimeProfile.ts).
 *
 * Engines without the standardised `zoom` get a `transform: scale()` canvas
 * instead (`appScaleStyle`), which Mapbox compensates itself: factor 1.
 */

interface MapContainerInternals {
  _container?: HTMLElement;
  _containerWidth: number;
  _containerHeight: number;
  _updateContainerDimensions?: () => void;
}

/** Product of the CSS `zoom` applied to `element` and its ancestors. */
export function readEffectiveCssZoom(element: Element): number {
  const native = (element as Element & { currentCSSZoom?: unknown }).currentCSSZoom;
  if (typeof native === 'number') return Number.isFinite(native) && native > 0 ? native : 1;
  let zoom = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = Number.parseFloat(window.getComputedStyle(node).zoom);
    if (Number.isFinite(value) && value > 0) zoom *= value;
  }
  return zoom;
}

let installed = false;

/** Patches `mapboxgl.Map` once; call before creating a map. */
export function installCssZoomAwareMapSizing(): void {
  if (installed) return;
  installed = true;
  const proto = mapboxgl.Map.prototype as unknown as MapContainerInternals;
  const measure = proto._updateContainerDimensions;
  if (typeof measure !== 'function') {
    console.warn('[map3d] Map#_updateContainerDimensions not found: map size under the canvas CSS zoom is not compensated');
    return;
  }
  proto._updateContainerDimensions = function updateContainerDimensions(this: MapContainerInternals) {
    measure.call(this);
    const container = this._container;
    if (!container || !supportsStandardZoom()) return;
    const zoom = readEffectiveCssZoom(container);
    if (zoom === 1) return;
    this._containerWidth = toLayoutPx(this._containerWidth, zoom);
    this._containerHeight = toLayoutPx(this._containerHeight, zoom);
  };
}

/**
 * The zoom is stored as a float32 (0.89 → 0.88999999): 890 / zoom gives
 * 1000.000016, which Mapbox ceils into a 1001 px backing row for a 1000 px
 * canvas — a 0.1 % resample of the whole frame. Layout sizes are multiples of
 * 1/64 px anyway.
 */
function toLayoutPx(zoomedPx: number, zoom: number): number {
  return Math.round((zoomedPx / zoom) * 1000) / 1000;
}
