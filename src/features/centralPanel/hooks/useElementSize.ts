/**
 * Hook returning the live { width, height } of an element via ResizeObserver.
 *
 * Used by the profile chart to keep its SVG viewport in sync with the
 * available area (the central panel is resizable on both axes).
 */
import { useEffect, useRef, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

export function useElementSize<E extends HTMLElement>(): {
  ref: React.RefObject<E | null>;
  size: Size;
} {
  const ref = useRef<E | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { width, height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}
