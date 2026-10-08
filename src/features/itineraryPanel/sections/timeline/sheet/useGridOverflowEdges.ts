import { useEffect, useLayoutEffect, useState } from 'react';
import { syncHorizontalOverflow } from '@/shared/hooks/useHorizontalScrollOverflow';

/**
 * `data-overflow` sur la grille de la feuille : quel bord a des colonnes de
 * données défilées sous les colonnes collantes de case / d'actions. Ce n'est
 * qu'alors que ces cellules ont besoin d'une surface opaque et d'une ombre de
 * bord ; sinon ce sont des cellules de ligne ordinaires.
 *
 * `layoutKey` (le gabarit de la grille) revérifie quand des colonnes sont
 * ajoutées, retirées ou redimensionnées : cela change la largeur de défilement
 * sans redimensionner la boîte de la grille, le ResizeObserver seul le raterait.
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
