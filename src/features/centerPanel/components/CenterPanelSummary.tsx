import {
  IconDotsVertical,
  IconEye,
  IconSettingsSliders,
} from './CenterPanelIcons';
import {
  useProjectStoreOptional,
  type Itinerary,
} from '@/features/itineraryPanel';

const PLACEHOLDER = '--';

const HEADER_CELLS = [
  'Distance',
  'Durée',
  'Dénivelé /',
  'Dénivelé -',
  'Pente moyenne',
  'Tarmac',
  'Off-road',
  '7%',
  '7%',
  '7%',
];

function formatDistance(km: number | undefined): string {
  if (km == null || !Number.isFinite(km)) return PLACEHOLDER;
  return km.toFixed(2);
}

function formatDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return PLACEHOLDER;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function formatAscent(m: number | undefined): string {
  if (m == null || !Number.isFinite(m)) return PLACEHOLDER;
  return `+${Math.round(m)}`;
}

function formatDescent(m: number | undefined): string {
  if (m == null || !Number.isFinite(m)) return PLACEHOLDER;
  return `-${Math.round(m)}`;
}

function formatPercent(p: number | undefined): string {
  if (p == null || !Number.isFinite(p)) return PLACEHOLDER;
  return `${Math.round(p)}%`;
}

/**
 * Pull the active distance for an itinerary. Prefers the explicit
 * `metrics.distanceKm` (set by the BRouter recompute) but falls back to
 * the timeline "end" row's `distanceKm` for projects that pre-date the
 * `metrics` field.
 */
function itineraryDistanceKm(it: Itinerary): number | undefined {
  if (it.metrics?.distanceKm != null) return it.metrics.distanceKm;
  const endRow = it.timeline.find((r) => r.kind === 'end');
  return endRow?.distanceKm ?? undefined;
}

function buildValues(it: Itinerary): string[] {
  const m = it.metrics ?? {};
  return [
    formatDistance(itineraryDistanceKm(it)),
    formatDuration(m.durationSec),
    formatAscent(m.ascentM),
    formatDescent(m.descentM),
    formatPercent(m.avgSlopePercent),
    formatPercent(m.tarmacPercent),
    formatPercent(m.offroadPercent),
    PLACEHOLDER,
    PLACEHOLDER,
    PLACEHOLDER,
  ];
}

const EMPTY_VALUES: string[] = HEADER_CELLS.map(() => PLACEHOLDER);

interface SummaryRowProps {
  itinerary: Itinerary;
}

function SummaryRow({ itinerary }: SummaryRowProps) {
  const values = buildValues(itinerary);
  const visible = itinerary.visible !== false;
  return (
    <div className="rvc-center-summary__row rvc-center-summary__row--item">
      <div
        className="rvc-center-summary__route"
        style={{ opacity: visible ? 1 : 0.45 }}
      >
        <span className="rvc-center-summary__eye" aria-hidden="true">
          <IconEye size={14} />
        </span>
        <span
          className="rvc-center-summary__color"
          aria-hidden="true"
          style={{ background: itinerary.color }}
        />
        <span
          className="rvc-center-summary__name"
          title={itinerary.name}
        >
          {itinerary.name}
        </span>
      </div>
      <div className="rvc-center-summary__metrics">
        {values.map((cell, index) => (
          <div
            key={`${itinerary.id}-${index}`}
            className="rvc-center-summary__metric"
            title={`${HEADER_CELLS[index]}: ${cell}`}
          >
            {cell}
          </div>
        ))}
      </div>
      <button
        className="rvc-center-summary__ghost-button"
        type="button"
        aria-label="Plus d'options"
      >
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

function EmptyRow() {
  return (
    <div className="rvc-center-summary__row rvc-center-summary__row--item">
      <div className="rvc-center-summary__route" style={{ opacity: 0.5 }}>
        <span className="rvc-center-summary__eye" aria-hidden="true">
          <IconEye size={14} />
        </span>
        <span
          className="rvc-center-summary__color"
          aria-hidden="true"
          style={{ background: 'rgba(255,255,255,0.18)' }}
        />
        <span className="rvc-center-summary__name">Aucun itinéraire</span>
      </div>
      <div className="rvc-center-summary__metrics">
        {EMPTY_VALUES.map((cell, index) => (
          <div
            key={`empty-${index}`}
            className="rvc-center-summary__metric"
            title={cell}
          >
            {cell}
          </div>
        ))}
      </div>
      <button
        className="rvc-center-summary__ghost-button"
        type="button"
        aria-label="Plus d'options"
        disabled
      >
        <IconDotsVertical size={16} />
      </button>
    </div>
  );
}

export function CenterPanelSummary() {
  const store = useProjectStoreOptional();
  const itineraries = store?.project.itineraries ?? [];

  return (
    <section className="rvc-center-summary" aria-label="Synthèse d'itinéraire">
      <div className="rvc-center-summary__row rvc-center-summary__row--header">
        <div className="rvc-center-summary__title">Synthèse</div>
        <div className="rvc-center-summary__metrics" aria-hidden="true">
          {HEADER_CELLS.map((cell) => (
            <div
              key={cell}
              className="rvc-center-summary__metric rvc-center-summary__metric--header"
              title={cell}
            >
              {cell}
            </div>
          ))}
        </div>
        <button
          className="rvc-center-summary__icon-button"
          type="button"
          aria-label="Réglages"
        >
          <IconSettingsSliders size={16} />
        </button>
      </div>

      {itineraries.length === 0 ? (
        <EmptyRow />
      ) : (
        itineraries.map((it) => (
          <SummaryRow key={it.id} itinerary={it} />
        ))
      )}
    </section>
  );
}
