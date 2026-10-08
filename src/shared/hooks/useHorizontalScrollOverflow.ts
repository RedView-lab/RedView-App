import { useEffect, type RefObject } from 'react';

const LINE_HEIGHT_PX = 16;

/**
 * Pose `data-overflow` sur un conteneur à défilement horizontal : `start` |
 * `end` | `both` (les bords qui cachent du contenu), absent quand tout tient.
 */
export function syncHorizontalOverflow(el: HTMLElement): void {
  const max = el.scrollWidth - el.clientWidth;
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft < max - 1;
  const state = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
  if (state) el.dataset.overflow = state;
  else delete el.dataset.overflow;
}

/**
 * Bande horizontale qui peut déborder de sa boîte (barre d'outils dans une
 * fenêtre en demi-écran) : une molette verticale la fait défiler de côté, et
 * `data-overflow` (voir {@link syncHorizontalOverflow}) indique au CSS quel
 * bord cache du contenu (masque de fondu).
 */
export function useHorizontalScrollOverflow(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => syncHorizontalOverflow(el);

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
