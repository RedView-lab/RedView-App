import { VIEWPORT_STORAGE_KEY as STORAGE_KEY } from './mapCacheEpoch';

const SAVE_DEBOUNCE_MS = 1000;

export interface MapViewport {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export function loadViewport(): MapViewport | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const vp: MapViewport = JSON.parse(raw);
    // Basic validation
    if (
      typeof vp.center?.[0] === 'number' &&
      typeof vp.center?.[1] === 'number' &&
      typeof vp.zoom === 'number' &&
      typeof vp.pitch === 'number' &&
      typeof vp.bearing === 'number'
    ) {
      return vp;
    }
  } catch { /* corrupted */ }
  return null;
}

export function saveViewport(vp: MapViewport): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vp));
  } catch { /* quota exceeded, non-critical */ }
}

export function createViewportTracker(
  getViewport: () => MapViewport,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      saveViewport(getViewport());
    }, SAVE_DEBOUNCE_MS);
  };

  return {
    start: () => save,
    stop: () => {
      if (timer) clearTimeout(timer);
      // Final save on cleanup
      saveViewport(getViewport());
    },
  };
}
