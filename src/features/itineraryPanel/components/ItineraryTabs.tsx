import { IconPlusCircle } from './icons';
import type { Itinerary } from '../types';

interface ItineraryTabsProps {
  itineraries: Itinerary[];
  activeId: string;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
}

export function ItineraryTabs({
  itineraries,
  activeId,
  onSelect,
  onAdd,
}: ItineraryTabsProps) {
  return (
    <nav className="rvi-itins" aria-label="Itinéraires">
      {itineraries.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`rvi-itin${it.id === activeId ? ' is-active' : ''}`}
          onClick={() => onSelect?.(it.id)}
        >
          <span className="rvi-itin__swatch" style={{ background: it.color }} />
          <span className="rvi-itin__label">{it.name}</span>
        </button>
      ))}
      <button type="button" className="rvi-itin" onClick={onAdd}>
        <IconPlusCircle size={12} />
        <span className="rvi-itin__label">Nouvel itinéraire</span>
      </button>
    </nav>
  );
}
