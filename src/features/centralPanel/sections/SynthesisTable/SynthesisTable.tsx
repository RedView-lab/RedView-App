/**
 * Synthesis table — top section of the Central Panel.
 *
 * Figma 1528:18339. One header row + one row per itinerary, plus optional
 * delta / total / average rows (hidden in the empty state, kept here as
 * declarative slots so the container can flip them on later).
 */
import { IconDots, IconEye, IconEyeOff, IconSettings } from '../../components/icons';
import {
  formatDistanceKm,
  formatDurationHHMMSS,
  formatGain,
  formatLoss,
  formatPercent,
} from '../../components/format';
import type { CentralPanelItinerary } from '../../types';

export interface SynthesisColumn {
  /** Stable id used as React key + when wiring sortable behaviour later. */
  id: string;
  label: string;
  /** Pull a value out of an itinerary's stats object and pre-format it. */
  render: (it: CentralPanelItinerary) => string;
  /** Visual width hint in px; the row layout uses CSS grid template. */
  widthPx?: number;
}

export const DEFAULT_SYNTHESIS_COLUMNS: SynthesisColumn[] = [
  { id: 'distance', label: 'Distance', render: (it) => formatDistanceKm(it.stats.distanceKm) },
  { id: 'duration', label: 'Durée', render: (it) => formatDurationHHMMSS(it.stats.durationSec) },
  { id: 'gain', label: 'Dénivelé +', render: (it) => formatGain(it.stats.elevationGainM) },
  { id: 'loss', label: 'Dénivelé -', render: (it) => formatLoss(it.stats.elevationLossM) },
  { id: 'avg-slope', label: 'Pente moyenne', render: (it) => formatPercent(it.stats.avgSlopePercent) },
  { id: 'tarmac', label: 'Tarmac', render: (it) => formatPercent(it.stats.surface.tarmac) },
  { id: 'gravel', label: 'Gravel', render: (it) => formatPercent(it.stats.surface.gravel) },
  { id: 'offroad', label: 'Off-road', render: (it) => formatPercent(it.stats.surface.offroad) },
];

interface SynthesisTableProps {
  itineraries: CentralPanelItinerary[];
  columns?: SynthesisColumn[];
  onToggleVisibility?: (id: string) => void;
  onRowAction?: (id: string, action: 'menu') => void;
  onOpenSettings?: () => void;
}

export function SynthesisTable({
  itineraries,
  columns = DEFAULT_SYNTHESIS_COLUMNS,
  onToggleVisibility,
  onRowAction,
  onOpenSettings,
}: SynthesisTableProps) {
  return (
    <section className="rvc-synthesis" aria-label="Synthèse des itinéraires">
      {/* Header row: label "Synthèse" + column titles + settings cog. */}
      <div className="rvc-synthesis__row rvc-synthesis__row--header">
        <div className="rvc-synthesis__label">Synthèse</div>
        <div className="rvc-synthesis__cells">
          {columns.map((c) => (
            <div key={c.id} className="rvc-synthesis__cell rvc-synthesis__cell--header">
              {c.label}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="rvc-synthesis__settings"
          aria-label="Paramètres de la synthèse"
          onClick={onOpenSettings}
        >
          <IconSettings size={16} />
        </button>
      </div>

      {/* Data rows. Empty state: render placeholders. */}
      {itineraries.length === 0 ? (
        <div className="rvc-synthesis__empty">
          Ajoutez un itinéraire pour voir sa synthèse.
        </div>
      ) : (
        itineraries.map((it) => (
          <SynthesisRow
            key={it.id}
            itinerary={it}
            columns={columns}
            onToggleVisibility={onToggleVisibility}
            onRowAction={onRowAction}
          />
        ))
      )}
    </section>
  );
}

interface SynthesisRowProps {
  itinerary: CentralPanelItinerary;
  columns: SynthesisColumn[];
  onToggleVisibility?: (id: string) => void;
  onRowAction?: (id: string, action: 'menu') => void;
}

function SynthesisRow({
  itinerary,
  columns,
  onToggleVisibility,
  onRowAction,
}: SynthesisRowProps) {
  return (
    <div className="rvc-synthesis__row">
      <div className="rvc-synthesis__label">
        <button
          type="button"
          className="rvc-synthesis__eye"
          aria-label={
            itinerary.visible
              ? `Masquer ${itinerary.name}`
              : `Afficher ${itinerary.name}`
          }
          onClick={() => onToggleVisibility?.(itinerary.id)}
        >
          {itinerary.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
        </button>
        <span
          className="rvc-synthesis__swatch"
          style={{ background: itinerary.color }}
          aria-hidden
        />
        <span className="rvc-synthesis__name" title={itinerary.name}>
          {itinerary.name}
        </span>
      </div>
      <div className="rvc-synthesis__cells">
        {columns.map((c) => (
          <div key={c.id} className="rvc-synthesis__cell">
            {c.render(itinerary)}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="rvc-synthesis__menu"
        aria-label={`Actions pour ${itinerary.name}`}
        onClick={() => onRowAction?.(itinerary.id, 'menu')}
      >
        <IconDots size={16} />
      </button>
    </div>
  );
}
