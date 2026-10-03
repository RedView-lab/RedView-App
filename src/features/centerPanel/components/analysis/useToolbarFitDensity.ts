import { useLayoutEffect, type RefObject } from 'react';

/** Highest compaction step defined in styles/analysis/responsive.css. */
const MAX_DENSITY = 4;

/** Wrapping units: the toolbar's children, and the chips inside the filter group (it wraps on its own). */
const ITEM_SELECTOR = ':scope > *, :scope > .rvc-center-analysis__filters > *';

/** True when one item starts below the bottom of another, i.e. the row broke. */
function wrapsOntoSecondRow(items: readonly Element[]): boolean {
  let firstRowBottom = Infinity;
  const tops: number[] = [];
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // display: none at this step
    firstRowBottom = Math.min(firstRowBottom, rect.bottom);
    tops.push(rect.top);
  }
  return tops.some((top) => top >= firstRowBottom - 0.5);
}

/**
 * Keeps the analysis toolbar on one row: picks the first compaction step whose
 * layout does not wrap, from the measured content rather than viewport
 * breakpoints, so it holds for any language, axis metric or surface label.
 * Step n is written as `data-density="1 … n"` so CSS matches "at least n" with
 * `[data-density~='n']`. The toolbar still wraps past the last step: its
 * dropdowns are positioned inside it, so it cannot become a scroller.
 */
export function useToolbarFitDensity(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const applyDensity = (level: number) => {
      if (level === 0) delete el.dataset.density;
      else el.dataset.density = Array.from({ length: level }, (_, i) => i + 1).join(' ');
    };

    const fit = () => {
      if (el.clientWidth === 0) return; // collapsed panel: keep the last step
      const items = Array.from(el.querySelectorAll(ITEM_SELECTOR));
      let level = 0;
      applyDensity(level);
      while (level < MAX_DENSITY && wrapsOntoSecondRow(items)) {
        level += 1;
        applyDensity(level);
      }
    };

    fit();

    // Width only: a step change alters the toolbar's height, not its width.
    let lastWidth = el.clientWidth;
    const resizeObserver = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fit();
    });
    resizeObserver.observe(el);

    // Labels change width on a language switch, an axis metric or a surface choice.
    const mutationObserver = new MutationObserver(fit);
    mutationObserver.observe(el, { childList: true, characterData: true, subtree: true });

    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) fit();
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [ref]);
}
