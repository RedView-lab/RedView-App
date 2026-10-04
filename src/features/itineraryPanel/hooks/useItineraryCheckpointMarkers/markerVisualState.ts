import { buildPopupClearanceOffset } from '@/features/map3d/lib/popupOffset';
import {
  CHECKPOINT_MIN_ZOOM,
  MARKER_MAX_SCALE_ZOOM,
  MARKER_MAX_SCREEN_SCALE,
  MARKER_MIN_SCALE_ZOOM,
  MARKER_MIN_SCREEN_SCALE,
} from './constants';
import type { MarkerRegistryEntry } from './types';

/** Échelle et visibilité des marqueurs selon le zoom, et décalage de leur popup. */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function getPoiMarkerVisualState(zoom: number): { scale: number } {
  const progress = smoothstep(MARKER_MIN_SCALE_ZOOM, MARKER_MAX_SCALE_ZOOM, zoom);
  return { scale: lerp(MARKER_MIN_SCREEN_SCALE, MARKER_MAX_SCREEN_SCALE, progress) };
}

/**
 * Pause pin (`.rv-poi-marker`, anchor 'bottom'): the pin and its duration
 * badge stand 75px × scale above the tip, ~30px × scale each side (time badge included).
 */
export function getPausePopupOffset(scale: number) {
  return buildPopupClearanceOffset({ above: 75 * scale, below: 0, side: 30 * scale });
}

/**
 * Pin départ / arrivée (`.rv-checkpoint-marker`, anchor 'bottom') : ~29px ×
 * scale au-dessus de la pointe, ~13px × scale de chaque côté.
 */
export function getEndpointPopupOffset(scale: number) {
  return buildPopupClearanceOffset({ above: 32 * scale, below: 0, side: 14 * scale });
}

function applyCheckpointZoomVisibility(element: HTMLElement, zoom: number): void {
  if (zoom < CHECKPOINT_MIN_ZOOM) {
    element.style.display = 'none';
    return;
  }
  element.style.display = '';
  const progress = Math.max(0, Math.min(1, (zoom - CHECKPOINT_MIN_ZOOM) / 6.0));
  const scale = 0.6 + progress * 0.4;
  element.style.setProperty('--rv-checkpoint-scale', scale.toFixed(3));
}

export function applyMarkerVisualState(entry: MarkerRegistryEntry, zoom: number): void {
  const el = entry.element;
  if (zoom < CHECKPOINT_MIN_ZOOM) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';

  if (entry.kind === 'pause' || entry.kind === 'waypoint') {
    const visual = getPoiMarkerVisualState(zoom);
    el.style.setProperty('--rv-poi-marker-scale', visual.scale.toFixed(3));
    if (entry.popup) {
      if (entry.kind === 'waypoint') {
        const offsetPx = Math.round(14 * visual.scale) + 4;
        entry.popup.setOffset([offsetPx, -offsetPx]);
      } else {
        entry.popup.setOffset(getPausePopupOffset(visual.scale));
      }
    }
  } else {
    applyCheckpointZoomVisibility(el, zoom);
    if (entry.popup) {
      const scale = Number(el.style.getPropertyValue('--rv-checkpoint-scale')) || 1;
      entry.popup.setOffset(getEndpointPopupOffset(scale));
    }
  }
}
