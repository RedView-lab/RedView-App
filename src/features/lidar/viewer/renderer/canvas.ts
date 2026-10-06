/** Id of the viewer's canvas in viewer.html. */
const VIEWER_CANVAS_ID = 'canvas';

/** Canvases an engine already took (and so a context type). */
const claimed = new WeakSet<HTMLCanvasElement>();

/**
 * The viewer canvas, ready for a new rendering context. A canvas keeps the
 * first context type created on it (`webgpu`, `webgl2`), so an engine that
 * takes over from another one gets a fresh copy of the element, swapped in
 * place (same id, attributes and size). Call before any listener is
 * attached to the canvas.
 */
export function claimViewerCanvas(): HTMLCanvasElement {
  const current = document.getElementById(VIEWER_CANVAS_ID);
  if (!(current instanceof HTMLCanvasElement)) throw new Error('viewer canvas missing');
  if (!claimed.has(current)) {
    claimed.add(current);
    return current;
  }
  const fresh = current.cloneNode(false) as HTMLCanvasElement;
  current.replaceWith(fresh);
  claimed.add(fresh);
  return fresh;
}
