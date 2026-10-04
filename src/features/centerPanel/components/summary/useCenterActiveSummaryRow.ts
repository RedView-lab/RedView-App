import { useEffect, useRef, type RefObject } from 'react';

/** `Collapse` unfolds in 220 ms: a row revealed by it is at its final place after that. */
const REVEAL_SETTLE_MS = 260;

/**
 * Centres the row of `rowId` in the summary's scroll box. Rects are screen px
 * (the dashboard canvas is CSS-zoomed by appScale), `scrollTop` is layout px.
 */
function centerSummaryRow(container: HTMLElement, rowId: string, behavior: ScrollBehavior): void {
  const row = container.querySelector<HTMLElement>(`[data-summary-row-id="${CSS.escape(rowId)}"]`);
  if (!row) return;
  const containerRect = container.getBoundingClientRect();
  if (!(containerRect.height > 0)) return;

  const toLayoutPx = container.offsetHeight / containerRect.height;
  const rowRect = row.getBoundingClientRect();
  const rowTop = container.scrollTop + (rowRect.top - containerRect.top) * toLayoutPx;
  const rowHeight = rowRect.height * toLayoutPx;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.min(maxTop, Math.max(0, rowTop - (container.clientHeight - rowHeight) / 2));
  if (Math.abs(top - container.scrollTop) < 1) return;
  container.scrollTo({ top, behavior });
}

/**
 * Keeps the active itinerary's row centred in the summary table: selected from
 * the map, the tabs or a split, it would otherwise sit outside the visible
 * rows. The table is placed instantly on mount and whenever `layout` changes
 * (docked ↔ fullscreen), then follows the selection smoothly — except when
 * `follow` is off (a row just clicked in the table is already under the pointer).
 */
export function useCenterActiveSummaryRow(
  containerRef: RefObject<HTMLElement | null>,
  activeId: string | null,
  rowCount: number,
  layout: string,
  follow: boolean,
): void {
  const placedLayoutRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!activeId || !container) return;

    const firstPlacement = placedLayoutRef.current !== layout;
    if (!firstPlacement && !follow) return;
    placedLayoutRef.current = layout;

    const behavior: ScrollBehavior = firstPlacement ? 'auto' : 'smooth';
    const frame = window.requestAnimationFrame(() => centerSummaryRow(container, activeId, behavior));
    // Second pass once a branch unfolded to reveal the row has settled (no-op otherwise).
    const settle = window.setTimeout(() => centerSummaryRow(container, activeId, behavior), REVEAL_SETTLE_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [activeId, containerRef, follow, layout, rowCount]);
}
