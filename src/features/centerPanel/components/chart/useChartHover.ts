import { useEffect, useRef, useState } from 'react';

export interface ChartHoverState {
  x: number;
  y: number;
  /** Normalized horizontal position in the chart [0, 1]. */
  ratioX: number;
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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setHover(null);
        return;
      }
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        setHover(null);
        return;
      }
      setHover({ x, y, ratioX: x / rect.width });
    };
    const clear = () => setHover(null);

    el.addEventListener('pointermove', update);
    el.addEventListener('pointerenter', update);
    el.addEventListener('pointerdown', update);
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
