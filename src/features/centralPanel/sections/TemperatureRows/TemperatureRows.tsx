/**
 * Temperature rows — Figma 1528:18591.
 *
 * One row per itinerary that opted-in to a temperature track. Each cell
 * shows the value at the matching X tick on the chart above. The bottom
 * row is an "Ajouter" picker (kept as a button — wiring comes later).
 *
 * The grid template mirrors the chart's tick count so cells line up with
 * the X axis labels visually.
 */
import { Select } from '../../components/primitives';
import { IconChevronDown, IconPlusCircle, IconTrash } from '../../components/icons';
import { formatTemperature } from '../../components/format';
import type { CentralPanelItinerary } from '../../types';

interface TemperatureRowsProps {
  itineraries: CentralPanelItinerary[];
  /** Number of bins displayed (must match the X-axis ticks above). */
  binCount: number;
  /** Pixel padding to align with the chart. */
  paddingLeft: number;
  paddingRight: number;
  onChangeMode?: (
    itineraryId: string,
    mode: 'measured' | 'forecast' | 'custom',
  ) => void;
  onRemoveRow?: (itineraryId: string) => void;
  onAddRow?: () => void;
}

const TEMP_MODE_OPTIONS = [
  { value: 'measured' as const, label: 'Tempé. mesurée' },
  { value: 'forecast' as const, label: 'Tempé. prévue' },
  { value: 'custom' as const, label: 'Tempé. personnalisée' },
];

export function TemperatureRows({
  itineraries,
  binCount,
  paddingLeft,
  paddingRight,
  onChangeMode,
  onRemoveRow,
  onAddRow,
}: TemperatureRowsProps) {
  const rows = itineraries.filter(
    (it) => it.visible && it.temperaturesC && it.temperaturesC.length > 0,
  );

  return (
    <section className="rvc-temp" aria-label="Températures">
      {rows.map((it) => (
        <div key={it.id} className="rvc-temp__row">
          <div className="rvc-temp__head">
            <span
              className="rvc-temp__swatch"
              style={{ background: it.color }}
              aria-hidden
            />
            <Select
              value="measured"
              options={TEMP_MODE_OPTIONS}
              onChange={(v) => onChangeMode?.(it.id, v)}
              ariaLabel={`Source de la température pour ${it.name}`}
            />
          </div>
          <div
            className="rvc-temp__cells"
            style={{ marginLeft: paddingLeft, marginRight: paddingRight }}
          >
            {Array.from({ length: binCount }).map((_, idx) => {
              const v = it.temperaturesC?.[idx];
              return (
                <div key={idx} className="rvc-temp__cell">
                  {formatTemperature(v ?? null)}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="rvc-temp__remove"
            aria-label={`Retirer la ligne ${it.name}`}
            onClick={() => onRemoveRow?.(it.id)}
          >
            <IconTrash size={12} />
          </button>
        </div>
      ))}

      <div className="rvc-temp__row rvc-temp__row--add">
        <button
          type="button"
          className="rvc-temp__add"
          onClick={onAddRow}
          aria-label="Ajouter une ligne de température"
        >
          <IconPlusCircle size={12} />
          <span>Ajouter</span>
          <IconChevronDown size={14} />
        </button>
      </div>
    </section>
  );
}
