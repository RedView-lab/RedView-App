import { useEffect, type RefObject } from 'react';

const LINE_HEIGHT_PX = 16;

/**
 * Horizontal strip that may overflow its box (toolbar in a half-screen
 * window): a vertical mouse wheel scrolls it sideways, and `data-overflow`
 * (`start` | `end` | `both`, absent when everything fits) tells CSS which
 * edge hides content (fade mask).
 */
export function useHorizontalScrollOverflow(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft < max - 1;
      const state = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
      if (state) el.dataset.overflow = state;
      else delete el.dataset.overflow;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
      event.preventDefault();
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', onWheel);
    };
  }, [ref]);
}
