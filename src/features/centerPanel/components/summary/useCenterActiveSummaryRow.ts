import { useEffect, useRef, type RefObject } from 'react';

/** `Collapse` se déplie en 220 ms : une ligne qu'il révèle est à sa place finale après ce délai. */
const REVEAL_SETTLE_MS = 260;

/**
 * Centre la ligne de `rowId` dans la boîte de défilement du résumé. Les rects
 * sont en px écran (le canvas du tableau de bord est zoomé en CSS par appScale),
 * `scrollTop` en px de mise en page.
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
 * Garde la ligne de l'itinéraire actif centrée dans le tableau du résumé :
 * sélectionnée depuis la carte, les onglets ou une découpe, elle serait sinon
 * hors des lignes visibles. Le tableau est placé instantanément au montage et à
 * chaque changement de `layout` (ancré ↔ plein écran), puis suit la sélection en
 * douceur — sauf quand `follow` est désactivé (une ligne qu'on vient de cliquer
 * dans le tableau est déjà sous le pointeur).
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
    // Seconde passe une fois stabilisée une branche dépliée pour révéler la ligne (sans effet sinon).
    const settle = window.setTimeout(() => centerSummaryRow(container, activeId, behavior), REVEAL_SETTLE_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [activeId, containerRef, follow, layout, rowCount]);
}
