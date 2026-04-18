import { useMemo } from 'react';
import { mondayIndex } from './dateUtils';

/**
 * Builds a 6-row × 7-col calendar matrix (always 42 cells, matching the
 * Figma design which leaks into the next month). Each cell carries the
 * actual local-midnight Date plus an `inMonth` flag so the renderer can
 * dim leading/trailing days at opacity 23 (Figma 7365:57971).
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
    const leading = mondayIndex(firstOfMonth); // 0..6 cells from prev month
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
