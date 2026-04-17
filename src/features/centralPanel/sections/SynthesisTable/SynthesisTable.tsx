/**
 * Synthesis table — top section of the Central Panel.
 *
 * Source of truth: Figma 1036:17515 ("SYNTHESIS"). Layout, per sub-frame:
 *   • Header row    — "Synthèse" label + dim column titles + settings cog
 *   • Selected row  — dark background, larger 16px values
 *   • Other rows    — translucent background, 12px values
 * Each itinerary row exposes: eye toggle, color swatch, name, value cells,
 * and an overflow ("more") menu trigger.
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
  /** Itinerary visually highlighted (dark bg + larger text). */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
  onRowAction?: (id: string, action: 'menu') => void;
  onOpenSettings?: () => void;
}

export function SynthesisTable({
  itineraries,
  columns = DEFAULT_SYNTHESIS_COLUMNS,
  selectedId,
  onSelect,
  onToggleVisibility,
  onRowAction,
  onOpenSettings,
}: SynthesisTableProps) {
  const effectiveSelectedId = selectedId ?? itineraries[0]?.id ?? null;

  return (
    <section className="rvc-synthesis" aria-label="Synthèse des itinéraires">
      <SynthesisHeader columns={columns} onOpenSettings={onOpenSettings} />

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
            selected={it.id === effectiveSelectedId}
            onSelect={onSelect}
            onToggleVisibility={onToggleVisibility}
            onRowAction={onRowAction}
          />
        ))
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

interface SynthesisHeaderProps {
  columns: SynthesisColumn[];
  onOpenSettings?: () => void;
}

function SynthesisHeader({ columns, onOpenSettings }: SynthesisHeaderProps) {
  return (
    <div className="rvc-synthesis__row rvc-synthesis__row--header">
      <div className="rvc-synthesis__label rvc-synthesis__label--header">
        Synthèse
      </div>
      <div className="rvc-synthesis__cells rvc-synthesis__cells--header">
        {columns.map((c) => (
          <div key={c.id} className="rvc-synthesis__cell">
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
  );
}

/* -------------------------------------------------------------------------- */
/* Itinerary row                                                              */
/* -------------------------------------------------------------------------- */

interface SynthesisRowProps {
  itinerary: CentralPanelItinerary;
  columns: SynthesisColumn[];
  selected?: boolean;
  onSelect?: (id: string) => void;
  onToggleVisibility?: (id: string) => void;
  onRowAction?: (id: string, action: 'menu') => void;
}

function SynthesisRow({
  itinerary,
  columns,
  selected,
  onSelect,
  onToggleVisibility,
  onRowAction,
}: SynthesisRowProps) {
  const rowClass = `rvc-synthesis__row rvc-synthesis__row--data${
    selected ? ' is-selected' : ''
  }`;

  return (
    <div
      className={rowClass}
      onClick={() => {
        if (!selected) onSelect?.(itinerary.id);
      }}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onKeyDown={(e) => {
        if (onSelect && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect(itinerary.id);
        }
      }}
    >
      <div className="rvc-synthesis__label">
        <button
          type="button"
          className="rvc-synthesis__eye"
          aria-label={
            itinerary.visible
              ? `Masquer ${itinerary.name}`
              : `Afficher ${itinerary.name}`
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility?.(itinerary.id);
          }}
        >
          {itinerary.visible ? <IconEye size={16} /> : <IconEyeOff size={16} />}
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
        onClick={(e) => {
          e.stopPropagation();
          onRowAction?.(itinerary.id, 'menu');
        }}
      >
        <IconDots size={16} />
      </button>
    </div>
  );
}
