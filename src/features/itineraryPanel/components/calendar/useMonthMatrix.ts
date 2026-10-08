import { useMemo } from 'react';
import { mondayIndex } from './dateUtils';

/**
 * Construit une matrice de calendrier de 6 lignes × 7 colonnes (toujours 42
 * cellules, comme la maquette Figma qui déborde sur le mois suivant). Chaque
 * cellule porte la vraie Date à minuit local plus un drapeau `inMonth` pour que
 * le rendu atténue les jours de début/fin à l'opacité 23 (Figma 7365:57971).
 */
export interface CalendarCell {
  date: Date;
  inMonth: boolean;
}

export function useMonthMatrix(viewMonth: Date): CalendarCell[] {
  return useMemo(() => {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();

    const firstOfMonth = new Date(year, month, 1);
    const leading = mondayIndex(firstOfMonth); // 0..6 cellules du mois précédent
    const gridStart = new Date(year, month, 1 - leading);

    const cells: CalendarCell[] = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + i,
      );
      cells.push({ date: d, inMonth: d.getMonth() === month });
    }
    return cells;
  }, [viewMonth]);
}
