import { useEffect, useState, type RefObject } from 'react';

export function usePlotAreaSize(ref: RefObject<HTMLElement | null>) {
  const [plotSize, setPlotSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const update = (width: number, height: number) => {
      setPlotSize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { width, height },
      );
    };

    const rect = node.getBoundingClientRect();
    update(rect.width, rect.height);

    let rafId = 0;
    let pendingWidth = 0;
    let pendingHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const targetRect = (entry.target as HTMLElement).getBoundingClientRect();
      pendingWidth = targetRect.width;
      pendingHeight = targetRect.height;
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        update(pendingWidth, pendingHeight);
      });
    });

    observer.observe(node);
    return () => {
      observer.disconnect();
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, [ref]);

  return plotSize;
}