import { useEffect, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons';
import { useMonthMatrix } from './useMonthMatrix';
import {
  WEEKDAY_LABELS,
  addMonths,
  formatLongFr,
  formatMonthEn,
  isSameDay,
  parseISO,
  startOfToday,
  toISO,
} from './dateUtils';

/**
 * Pixel-perfect calendar grid (Figma node 1710:47397).
 *
 * Composition (top-to-bottom):
 *   • Header     — chevron-left · "January 2025" · chevron-right (32 px)
 *   • Actions    — long French date pill (flex 1) + "Today" pill (74 × 30)
 *   • Dates      — 7-col grid: weekday headers + 6 rows of 40 × 40 cells
 *
 * Behaviour:
 *   • Controlled by an ISO `yyyy-mm-dd` string (matches RhythmState.startDate).
 *   • Internal `viewMonth` lets the user navigate without changing selection.
 *   • Picking a day OR clicking "Today" both call `onSelect(iso)`.
 *   • A small 5×5 dot under day 1 / 4 mirrors the Figma "marker" affordance,
 *     emitted only when `markedDates` (ISO strings) contains that cell.
 */
export interface CalendarProps {
  /** Selected day as ISO `yyyy-mm-dd`, or null when nothing is picked. */
  value: string | null;
  onSelect: (iso: string) => void;
  /** Optional ISO list of marker dots (Figma 7365:57927). */
  markedDates?: ReadonlyArray<string>;
}

export function Calendar({ value, onSelect, markedDates }: CalendarProps) {
  const selected = parseISO(value);
  const today = startOfToday();
  const initialView = selected ?? today;
  const [viewMonth, setViewMonth] = useState<Date>(initialView);

  // Re-sync the visible month if the parent changes the selection externally.
  useEffect(() => {
    if (!selected) return;
    if (
      selected.getFullYear() !== viewMonth.getFullYear() ||
      selected.getMonth() !== viewMonth.getMonth()
    ) {
      setViewMonth(selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const cells = useMonthMatrix(viewMonth);
  const markedSet = new Set(markedDates ?? []);
  const longLabel = selected
    ? formatLongFr(selected)
    : formatLongFr(today);

  return (
    <div className="rvi-calendar" role="dialog" aria-label="Sélection de date">
      {/* Header — month nav */}
      <div className="rvi-calendar__month">
        <button
          type="button"
          className="rvi-calendar__navbtn"
          aria-label="Mois précédent"
          onClick={() => setViewMonth((m) => addMonths(m, -1))}
        >
          <IconChevronLeft size={20} />
        </button>
        <span className="rvi-calendar__title">{formatMonthEn(viewMonth)}</span>
        <button
          type="button"
          className="rvi-calendar__navbtn"
          aria-label="Mois suivant"
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
        >
          <IconChevronRight size={20} />
        </button>
      </div>

      {/* Actions — long label + Today */}
      <div className="rvi-calendar__actions">
        <div className="rvi-calendar__active" aria-live="polite">
          {longLabel}
        </div>
        <button
          type="button"
          className="rvi-calendar__today"
          onClick={() => {
            setViewMonth(today);
            onSelect(toISO(today));
          }}
        >
          Today
        </button>
      </div>

      {/* Dates grid */}
      <div className="rvi-calendar__dates" role="grid">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="rvi-calendar__cell rvi-calendar__cell--head">
            <span className="rvi-calendar__weekday">{label}</span>
          </div>
        ))}
        {cells.map((cell) => {
          const iso = toISO(cell.date);
          const isSelected = isSameDay(cell.date, selected);
          const isToday = !isSelected && isSameDay(cell.date, today);
          const isMuted = !cell.inMonth;
          const showDot = markedSet.has(iso);
          return (
            <button
              type="button"
              key={iso}
              role="gridcell"
              aria-selected={isSelected}
              aria-current={isToday ? 'date' : undefined}
              className={
                'rvi-calendar__cell rvi-calendar__cell--day' +
                (isSelected ? ' is-selected' : '') +
                (isMuted ? ' is-muted' : '') +
                (isToday ? ' is-today' : '')
              }
              onClick={() => onSelect(iso)}
            >
              <span className="rvi-calendar__day">{cell.date.getDate()}</span>
              {showDot ? <span className="rvi-calendar__dot" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
