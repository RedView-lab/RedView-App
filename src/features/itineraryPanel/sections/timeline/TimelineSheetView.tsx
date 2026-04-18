/**
 * "Feuille de route" — flat sheet layout.
 *
 * A single-column list of TimelineRow items preceded by a column-header row
 * and ended by a "+ Ajouter un élément" split button.
 *
 * The component is fully stateless: all selection / visibility / favorite
 * state flows through parent-provided callbacks.
 */
import type { TimelineItem } from '../../types';
import { TimelineAddRow } from './TimelineAddRow';
import { TimelineRow } from './TimelineRow';

interface TimelineSheetViewProps {
  items: TimelineItem[];
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, selected: boolean) => void;
  onToggleVisibility?: (id: string, visible: boolean) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onRemove?: (id: string) => void;
  onAdd?: () => void;
  onOpenKindMenu?: () => void;
  onSelectPlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;
}

export function TimelineSheetView({
  items,
  selectedIds,
  onToggleSelect,
  onToggleVisibility,
  onToggleFavorite,
  onRemove,
  onAdd,
  onOpenKindMenu,
  onSelectPlace,
}: TimelineSheetViewProps) {
  return (
    <div className="rvi-tl-list" role="list" aria-label="Liste des étapes">
      <div className="rvi-tl-list__header" role="presentation">
        <span className="rvi-tl-list__col-check" aria-hidden>
          <span className="rvi-tl-list__col-checkbox" />
        </span>
        <span className="rvi-tl-list__col-type">Type</span>
        <span className="rvi-tl-list__col-flex" />
        <span className="rvi-tl-list__col-distance">Distance</span>
        <span className="rvi-tl-list__col-actions" aria-hidden />
      </div>

      {items.map((item, index) => (
        <div
          key={item.id}
          role="listitem"
          className="rvi-tl-list__item"
          style={{ animationDelay: `${Math.min(index * 18, 240)}ms` }}
        >
          <TimelineRow
            item={item}
            selected={selectedIds?.has(item.id)}
            onToggleSelect={onToggleSelect}
            onToggleVisibility={onToggleVisibility}
            onToggleFavorite={onToggleFavorite}
            onRemove={onRemove}
            onSelectPlace={onSelectPlace}
          />
        </div>
      ))}

      <TimelineAddRow onAdd={onAdd} onOpenKindMenu={onOpenKindMenu} />
    </div>
  );
}
