import type { CSSProperties } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { formatDayLabel, relativeDayNumber, toDayKey } from './utils';

interface TimelineScheduleHeaderProps {
  displayDays: Date[];
  /** Sans date de départ : « Jour 1 », « Jour 2 »… au lieu des dates. */
  relativeDays: boolean;
  selectedDayKey: string;
  onSelectDay: (dayKey: string) => void;
}

export function TimelineScheduleHeader({
  displayDays,
  relativeDays,
  selectedDayKey,
  onSelectDay,
}: TimelineScheduleHeaderProps) {
  const { locale, t } = useAppI18n();
  const headerGridStyle = {
    '--rvi-tl-header-day-count': String(Math.max(1, displayDays.length)),
  } as CSSProperties;

  return (
    <>
      <div className="rvi-tl-schedule__days" role="tablist" aria-label={t("Jours de l'agenda")}>
        <div className="rvi-tl-schedule__days-grid" style={headerGridStyle}>
          {displayDays.map((day) => {
            const dayKey = toDayKey(day);
            const isSelected = dayKey === selectedDayKey;
            return (
              <button
                key={dayKey}
                type="button"
                role="tab"
                aria-selected={isSelected}
                className={`rvi-tl-schedule__day${isSelected ? ' is-selected' : ''}`}
                onClick={() => onSelectDay(dayKey)}
              >
                <span className="rvi-tl-schedule__day-label">{relativeDays ? t('Jour') : formatDayLabel(day, locale)}</span>
                <span className="rvi-tl-schedule__day-number">{relativeDays ? relativeDayNumber(day) : day.getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rvi-tl-schedule__legend" aria-hidden>
        <span className="rvi-tl-schedule__legend-grid">
          <span className="rvi-tl-schedule__legend-name">{t('Nom')}</span>
          <span className="rvi-tl-schedule__legend-pause">{t('Pause')}</span>
          <span className="rvi-tl-schedule__legend-metric">{t('Depuis le départ')}</span>
          <span className="rvi-tl-schedule__legend-next">{t("Jusqu'au suivant")}</span>
        </span>
      </div>
    </>
  );
}