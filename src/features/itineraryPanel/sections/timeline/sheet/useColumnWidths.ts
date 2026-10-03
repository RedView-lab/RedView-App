import { useCallback, useRef, useState } from 'react';
import type { TimelineColumnDef, TimelineColumnId } from '../TimelineColumns';

const TIMELINE_COLUMN_WIDTHS_STORAGE_KEY = 'rvi-timeline-column-widths';

function readStoredColumnWidths(): Partial<Record<TimelineColumnId, number>> {
  try {
    const raw = localStorage.getItem(TIMELINE_COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Largeurs de colonnes redimensionnées à la souris, mémorisées dans localStorage. */
export function useColumnWidths() {
  const [columnWidths, setColumnWidths] = useState<Partial<Record<TimelineColumnId, number>>>(() =>
    readStoredColumnWidths(),
  );
  const [resizingColId, setResizingColId] = useState<TimelineColumnId | null>(null);
  // Tenu à jour par chaque écriture de `columnWidths` (lu par les gestionnaires de glisser).
  const columnWidthsRef = useRef(columnWidths);

  const handleResizeStart = useCallback(
    (col: TimelineColumnDef, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const initialWidth =
        columnWidthsRef.current[col.id] ?? col.defaultWidth ?? col.minWidth;
      const minW = col.minWidth ?? 40;

      setResizingColId(col.id);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = Math.max(minW, Math.round(initialWidth + delta));
        setColumnWidths((prev) => {
          const next = { ...prev, [col.id]: nextWidth };
          columnWidthsRef.current = next;
          return next;
        });
      };

      const onMouseUp = () => {
        setResizingColId(null);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        try {
          localStorage.setItem(
            TIMELINE_COLUMN_WIDTHS_STORAGE_KEY,
            JSON.stringify(columnWidthsRef.current),
          );
        } catch {
          // ignore
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [],
  );

  const handleResetColWidth = useCallback((col: TimelineColumnDef, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setColumnWidths((prev) => {
      const next = { ...prev };
      delete next[col.id];
      columnWidthsRef.current = next;
      try {
        localStorage.setItem(
          TIMELINE_COLUMN_WIDTHS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { columnWidths, resizingColId, handleResizeStart, handleResetColWidth };
}
