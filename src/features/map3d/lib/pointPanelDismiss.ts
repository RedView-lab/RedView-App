/**
 * Utility to manage dismissal of map point panels (POI popup, waypoint popup,
 * pause popup on/off route, draft POI card, context menu, etc.).
 *
 * Ensures that when a user clicks on the map to dismiss an open point panel,
 * that click ONLY closes the panel and does NOT trigger any other planning action
 * (such as appending a trace point or creating a drag-waypoint).
 */

let isPressDismissingPointPanel = false;
let lastPointPanelDismissTimestamp = 0;

/**
 * Returns true if an interactive point panel or popup is currently open in the DOM,
 * and the target (if provided) is not inside that panel.
 */
export function isPointPanelOpen(target?: EventTarget | null): boolean {
  if (typeof document === 'undefined') return false;

  if (target instanceof Element) {
    if (
      target.closest(
        '.mapboxgl-popup, .rv-poi-draft-card, [data-rv-poi-draft-card], .rv-checkpoint-popup, .rv-poi-popup, .rv-map-context-menu',
      )
    ) {
      return false;
    }
  }

  // 1. Any Mapbox popup attached to the DOM (POI, checkpoint, waypoint, pause, search)
  const popups = document.querySelectorAll('.mapboxgl-popup');
  for (const el of popups) {
    if (el instanceof HTMLElement && el.offsetParent !== null) {
      return true;
    }
  }

  // 2. Draft POI card
  const draftCard = document.querySelector('.rv-poi-draft-card, [data-rv-poi-draft-card]');
  if (draftCard instanceof HTMLElement && draftCard.offsetParent !== null) {
    return true;
  }

  // 3. Right-click context menu on map
  const contextMenu = document.querySelector('.rv-map-context-menu');
  if (contextMenu instanceof HTMLElement && contextMenu.offsetParent !== null) {
    return true;
  }

  return false;
}

/**
 * Call on `mousedown` on the map or canvas. If a point panel is open, records that
 * this press sequence is meant to dismiss the panel.
 */
export function handlePointPanelMousedown(target: EventTarget | null): boolean {
  if (isPointPanelOpen(target)) {
    isPressDismissingPointPanel = true;
    lastPointPanelDismissTimestamp = Date.now();
    return true;
  }
  return false;
}

/**
 * Call in `click` handlers (e.g. TraceToolContext, RouteDragWaypointContext, RouteSplitToolContext).
 * Returns true if this click was used to dismiss a point panel, in which case the click
 * should be ignored and perform NO action.
 */
export function shouldIgnoreMapClickAfterPanelDismiss(
  target: EventTarget | null,
  thresholdMs: number = 400,
): boolean {
  if (isPressDismissingPointPanel) {
    isPressDismissingPointPanel = false;
    lastPointPanelDismissTimestamp = Date.now();
    return true;
  }

  if (Date.now() - lastPointPanelDismissTimestamp < thresholdMs) {
    return true;
  }

  if (isPointPanelOpen(target)) {
    lastPointPanelDismissTimestamp = Date.now();
    return true;
  }

  return false;
}

/**
 * Makes a second click on a marker whose popup is open close that popup.
 *
 * Mapbox closes a `closeOnClick` popup on `preclick`, then the marker toggles
 * it back open on `click`, so re-clicking an open marker kept its panel open.
 * This listener runs before the map's (bubbling, child element): it closes
 * the panel and stops there.
 */
export function closeMarkerPopupOnSecondClick(
  element: HTMLElement,
  popup: { isOpen: () => boolean; remove: () => unknown },
): void {
  element.addEventListener('click', (event) => {
    if (!popup.isOpen()) return;
    event.stopPropagation();
    popup.remove();
  });
}
