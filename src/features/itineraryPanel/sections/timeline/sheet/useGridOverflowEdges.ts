import { useEffect, useLayoutEffect, useState } from 'react';
import { syncHorizontalOverflow } from '@/shared/hooks/useHorizontalScrollOverflow';

/**
 * `data-overflow` on the sheet grid: which edge has data columns scrolled
 * beneath the sticky check / actions columns. Only then do those cells need
 * an opaque surface and an edge shadow; otherwise they are plain row cells.
 *
 * `layoutKey` (the grid template) re-checks when columns are added, removed
 * or resized: that changes the scroll width without resizing the grid box,
 * so the ResizeObserver alone would miss it.
 */
export function useGridOverflowEdges(layoutKey: string): (grid: HTMLElement | null) => void {
  const [grid, setGrid] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!grid) return;
    const update = () => syncHorizontalOverflow(grid);
    // Initial callback on observe: first state.
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    grid.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      grid.removeEventListener('scroll', update);
    };
  }, [grid]);

  useLayoutEffect(() => {
    if (grid) syncHorizontalOverflow(grid);
  }, [grid, layoutKey]);

  return setGrid;
}
