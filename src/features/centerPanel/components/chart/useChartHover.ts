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
  const lastHoverRef = useRef<ChartHoverState | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const commitHover = (nextHover: ChartHoverState | null) => {
      if (sameHoverState(lastHoverRef.current, nextHover)) return;
      lastHoverRef.current = nextHover;
      setHover(nextHover);
    };

    const update = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        commitHover(null);
        return;
      }

      const rawX = event.clientX - rect.left;
      const rawY = event.clientY - rect.top;
      if (rawX < 0 || rawX > rect.width || rawY < 0 || rawY > rect.height) {
        commitHover(null);
        return;
      }

      const x = Math.max(0, Math.min(rect.width, rawX));
      const y = Math.max(0, Math.min(rect.height, rawY));
      const ratioX = rect.width > 0 ? x / rect.width : 0;

      commitHover({ x, y, ratioX });
    };

    const clear = () => {
      commitHover(null);
    };

    el.addEventListener('pointermove', update, { passive: true });
    el.addEventListener('pointerenter', update, { passive: true });
    el.addEventListener('pointerdown', update, { passive: true });
    el.addEventListener('pointerleave', clear);
    el.addEventListener('pointercancel', clear);

    return () => {
      el.removeEventListener('pointermove', update);
      el.removeEventListener('pointerenter', update);
      el.removeEventListener('pointerdown', update);
      el.removeEventListener('pointerleave', clear);
      el.removeEventListener('pointercancel', clear);
    };
  }, []);

  return { ref, hover } as const;
}
