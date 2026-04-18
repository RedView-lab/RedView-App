import { IconEye, IconPlusCircle, IconTrash } from './icons';
import type { Itinerary } from '../types';

interface ItineraryTabsProps {
  itineraries: Itinerary[];
  activeId: string;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
  /** Optional remove-itinerary handler. When provided AND there is more than
   * one itinerary, each tab shows a small trash button next to its name. */
  onRemove?: (id: string) => void;
}

export function ItineraryTabs({
  itineraries,
  activeId,
  onSelect,
  onAdd,
  onRemove,
}: ItineraryTabsProps) {
  const canRemove = itineraries.length > 1 && Boolean(onRemove);
  return (
    <nav className="rvi-itins" aria-label="Itinéraires">
      {itineraries.map((it) => (
        <span
          key={it.id}
          className={`rvi-itin-wrap${it.id === activeId ? ' is-active' : ''}`}
        >
          <button
            type="button"
            className={`rvi-itin${it.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect?.(it.id)}
          >
            <span className="rvi-itin__eye" aria-hidden>
              <IconEye size={16} />
            </span>
            <span className="rvi-itin__swatch" style={{ background: it.color }} />
            <span className="rvi-itin__label">{it.name}</span>
            {it.gpxRoute ? (
              <span className="rvi-itin__badge" title="Itinéraire chargé depuis un GPX">
                GPX
              </span>
            ) : null}
          </button>
          {canRemove ? (
            <button
              type="button"
              className="rvi-itin__remove"
              aria-label={`Supprimer ${it.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove?.(it.id);
              }}
            >
              <IconTrash size={11} />
            </button>
          ) : null}
        </span>
      ))}
      <button type="button" className="rvi-itin rvi-itin--add" onClick={onAdd}>
        <IconPlusCircle size={12} />
        <span className="rvi-itin__label">Nouvel itinéraire</span>
      </button>
    </nav>
  );
}
