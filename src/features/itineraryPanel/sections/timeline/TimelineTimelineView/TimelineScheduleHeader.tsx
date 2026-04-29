import { formatDayLabel, toDayKey } from './utils';

interface TimelineScheduleHeaderProps {
  displayDays: Date[];
  selectedDayKey: string;
  onSelectDay: (dayKey: string) => void;
}

export function TimelineScheduleHeader({
  displayDays,
  selectedDayKey,
  onSelectDay,
}: TimelineScheduleHeaderProps) {
  return (
    <>
      <div className="rvi-tl-schedule__days" role="tablist" aria-label="Jours de la timeline">
        <span className="rvi-tl-schedule__days-spacer" aria-hidden />
        <div className="rvi-tl-schedule__days-grid">
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
                <span className="rvi-tl-schedule__day-label">{formatDayLabel(day)}</span>
                <span className="rvi-tl-schedule__day-number">{day.getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rvi-tl-schedule__legend" aria-hidden>
        <span className="rvi-tl-schedule__legend-spacer" />
        <span className="rvi-tl-schedule__legend-grid">
          <span className="rvi-tl-schedule__legend-name">Name</span>
          <span className="rvi-tl-schedule__legend-pause" />
          <span className="rvi-tl-schedule__legend-metric">From Start</span>
          <span className="rvi-tl-schedule__legend-next">To next</span>
        </span>
      </div>
    </>
  );
}