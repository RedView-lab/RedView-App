import { useState } from 'react';
import { useHasChanged } from '@/shared/hooks/useHasChanged';
import { useAppI18n } from '@/shared/i18n';
import { IconChevronLeft, IconChevronRight } from './icons';
import { useMonthMatrix } from './useMonthMatrix';
import {
  addMonths,
  isSameDay,
  parseISO,
  startOfToday,
  toISO,
} from './dateUtils';

/**
 * Grille de calendrier au pixel près (nœud Figma 1710:47397).
 *
 * Composition (de haut en bas) :
 *   • En-tête  — chevron gauche · « Janvier 2025 » · chevron droit (32 px)
 *   • Actions  — pastille de date longue en français (flex 1) + pastille « Aujourd'hui » (74 × 30)
 *   • Dates    — grille de 7 colonnes : en-têtes des jours + 6 lignes de cellules 40 × 40
 *
 * Comportement :
 *   • Contrôlé par une chaîne ISO `yyyy-mm-dd` (comme RhythmState.startDate).
 *   • Un `viewMonth` interne permet de naviguer sans changer la sélection.
 *   • Choisir un jour OU cliquer « Aujourd'hui » appellent tous deux `onSelect(iso)`.
 *   • Un petit point de 5×5 sous le jour 1 / 4 reprend le « marqueur » de Figma,
 *     émis seulement quand `markedDates` (chaînes ISO) contient cette cellule.
 */
export interface CalendarProps {
  /** Jour sélectionné en ISO `yyyy-mm-dd`, ou null quand rien n'est choisi. */
  value: string | null;
  onSelect: (iso: string) => void;
  /** Liste ISO optionnelle des points marqueurs (Figma 7365:57927). */
  markedDates?: ReadonlyArray<string>;
}

export function Calendar({ value, onSelect, markedDates }: CalendarProps) {
  const { locale, t } = useAppI18n();
  const selected = parseISO(value);
  const today = startOfToday();
  const initialView = selected ?? today;
  const [viewMonth, setViewMonth] = useState<Date>(initialView);

  const weekdayLabels = locale === 'fr'
    ? ['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di']
    : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const formatLongLabel = (date: Date) => new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  const formatMonthLabel = (date: Date) => new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    month: 'long',
    year: 'numeric',
  }).format(date);

  // Resynchroniser le mois visible si le parent change la sélection de l'extérieur
  // (ajusté pendant le rendu : jamais un rendu avec l'ancien mois à l'écran).
  const valueChanged = useHasChanged(value);
  if (
    valueChanged &&
    selected &&
    (selected.getFullYear() !== viewMonth.getFullYear() || selected.getMonth() !== viewMonth.getMonth())
  ) {
    setViewMonth(selected);
  }

  const cells = useMonthMatrix(viewMonth);
  const markedSet = new Set(markedDates ?? []);
  const longLabel = selected
    ? formatLongLabel(selected)
    : formatLongLabel(today);

  return (
    <div className="rvi-calendar" role="dialog" aria-label={t('Sélection de date')}>
      {/* En-tête — navigation entre mois */}
      <div className="rvi-calendar__month">
        <button
          type="button"
          className="rvi-calendar__navbtn"
          aria-label={t('Mois précédent')}
          onClick={() => setViewMonth((m) => addMonths(m, -1))}
        >
          <IconChevronLeft size={16} />
        </button>
        <span className="rvi-calendar__title">{formatMonthLabel(viewMonth)}</span>
        <button
          type="button"
          className="rvi-calendar__navbtn"
          aria-label={t('Mois suivant')}
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      {/* Actions — libellé long + Aujourd'hui */}
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
          {t("Aujourd'hui")}
        </button>
      </div>

      {/* Grille des dates */}
      <div className="rvi-calendar__dates" role="grid">
        {weekdayLabels.map((label) => (
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
