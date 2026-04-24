import { useEffect, useRef, useState } from 'react';

export interface ChartHoverState {
  x: number;
  y: number;
  /** Normalized horizontal position in the chart [0, 1]. */
  ratioX: number;
}

const HOVER_POSITION_EPSILON_PX = 0.5;
const HOVER_RATIO_EPSILON = 1e-4;

function sameHoverState(left: ChartHoverState | null, right: ChartHoverState | null): boolean {
  if (!left || !right) return left === right;
  return (
    Math.abs(left.x - right.x) <= HOVER_POSITION_EPSILON_PX &&
    Math.abs(left.y - right.y) <= HOVER_POSITION_EPSILON_PX &&
    Math.abs(left.ratioX - right.ratioX) <= HOVER_RATIO_EPSILON
  );
}

/**
 * Tracks pointer position over a chart container element.
 * Returns a ref to attach to the container, and the current hover state
 * (or null when the pointer is outside).
 *
 * The container element is the single source of truth for pointer events:
 * all visual layers above it must use `pointer-events: none`.
 */
export function useChartHover<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const hoverRafIdRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastHoverRef = useRef<ChartHoverState | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const commitHover = (nextHover: ChartHoverState | null) => {
      if (sameHoverState(lastHoverRef.current, nextHover)) return;
      lastHoverRef.current = nextHover;
      setHover(nextHover);
    };

    const flushPendingPointer = () => {
      hoverRafIdRef.current = null;
      const pointer = pendingPointerRef.current;
      pendingPointerRef.current = null;
      if (!pointer) return;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        commitHover(null);
        return;
      }

      const x = pointer.clientX - rect.left;
      const y = pointer.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        commitHover(null);
        return;
      }

      commitHover({ x, y, ratioX: x / rect.width });
    };

    const update = (event: PointerEvent) => {
      pendingPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (hoverRafIdRef.current !== null) return;
      hoverRafIdRef.current = window.requestAnimationFrame(flushPendingPointer);
    };

    const clear = () => {
      pendingPointerRef.current = null;
      if (hoverRafIdRef.current !== null) {
        window.cancelAnimationFrame(hoverRafIdRef.current);
        hoverRafIdRef.current = null;
      }
      commitHover(null);
    };

    el.addEventListener('pointermove', update);
    el.addEventListener('pointerenter', update);
    el.addEventListener('pointerdown', update);
    el.addEventListener('pointerleave', clear);
    el.addEventListener('pointercancel', clear);

    return () => {
      if (hoverRafIdRef.current !== null) {
        window.cancelAnimationFrame(hoverRafIdRef.current);
        hoverRafIdRef.current = null;
      }
      el.removeEventListener('pointermove', update);
      el.removeEventListener('pointerenter', update);
      el.removeEventListener('pointerdown', update);
      el.removeEventListener('pointerleave', clear);
      el.removeEventListener('pointercancel', clear);
    };
  }, []);

  return { ref, hover } as const;
}
