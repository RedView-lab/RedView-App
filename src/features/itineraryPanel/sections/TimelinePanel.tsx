import {
  IconSearch,
  IconSettingsSliders,
  IconPlus,
  IconLayoutGrid,
  IconClockFastForward,
  IconCheckpointFlag,
  IconCheckpointEnd,
  IconMapPin,
  IconEye,
  IconStar,
  IconTrash,
  IconChevronDown,
} from '../components/icons';
import type { TimelineItem, TimelineView } from '../types';

interface TimelinePanelProps {
  items: TimelineItem[];
  view: TimelineView;
  onChangeView?: (v: TimelineView) => void;
  onSearch?: () => void;
  onOpenSettings?: () => void;
  onAdd?: () => void;
  onToggleItem?: (id: string, visible: boolean) => void;
  onFavoriteItem?: (id: string, favorite: boolean) => void;
  onRemoveItem?: (id: string) => void;
}

function KindIcon({ kind }: { kind: TimelineItem['kind'] }) {
  switch (kind) {
    case 'start':
      return <IconCheckpointFlag size={16} />;
    case 'end':
      return <IconCheckpointEnd size={16} />;
    case 'waypoint':
      return <IconMapPin size={14} />;
    case 'pause':
      return <IconClockFastForward size={14} />;
    default:
      return <IconMapPin size={14} />;
  }
}

function kindLabel(kind: TimelineItem['kind']): string {
  switch (kind) {
    case 'start':
      return 'Départ';
    case 'end':
      return 'Arrivée';
    case 'waypoint':
      return 'Étape';
    case 'pause':
      return 'Pause';
    default:
      return '';
  }
}

function formatDistance(km: number | null): string {
  if (km === null) return '--';
  if (km === 0) return '0 km';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function TimelinePanel({
  items,
  view,
  onChangeView,
  onSearch,
  onOpenSettings,
  onAdd,
  onToggleItem,
  onFavoriteItem,
  onRemoveItem,
}: TimelinePanelProps) {
  return (
    <section className="rvi-timeline" aria-label="Feuille de route">
      <div className="rvi-timeline__head">
        <div className="rvi-timeline__viewgroup">
          <button
            type="button"
            className={`rvi-timeline__viewbtn${view === 'sheet' ? ' is-active' : ''}`}
            onClick={() => onChangeView?.('sheet')}
          >
            <IconLayoutGrid size={16} />
            <span>Feuille de route</span>
          </button>
          <button
            type="button"
            className={`rvi-timeline__viewbtn${view === 'timeline' ? ' is-active' : ''}`}
            onClick={() => onChangeView?.('timeline')}
          >
            <IconClockFastForward size={16} />
            <span>Timeline</span>
          </button>
        </div>
        <button
          type="button"
          className="rvi-timeline__tool"
          onClick={onSearch}
          aria-label="Rechercher"
        >
          <IconSearch size={14} />
        </button>
        <button
          type="button"
          className="rvi-timeline__tool"
          onClick={onOpenSettings}
          aria-label="Paramètres"
        >
          <IconSettingsSliders size={14} />
        </button>
        <button
          type="button"
          className="rvi-timeline__tool rvi-timeline__tool--red"
          onClick={onAdd}
          aria-label="Ajouter"
        >
          <IconPlus size={14} />
        </button>
      </div>

      <div className="rvi-timeline__list">
        <div className="rvi-timeline__header">
          <span
            className="rvi-timeline__header-label"
            style={{ width: 20, textAlign: 'center' }}
          >
            #
          </span>
          <span
            className="rvi-timeline__header-label"
            style={{ width: 52 }}
          >
            Type
          </span>
          <span className="rvi-timeline__header-label rvi-timeline__header-label--flex">
            Nom
          </span>
          <span className="rvi-timeline__header-label rvi-timeline__header-label--right">
            Distance
          </span>
          <span
            className="rvi-timeline__header-label"
            style={{ width: 60, textAlign: 'right' }}
          >
            Actions
          </span>
        </div>

        {items.map((item, idx) => {
          const isPlaceholder = item.label === 'Rechercher un lieu';
          return (
            <div
              key={item.id}
              className={`rvi-timeline__row${
                isPlaceholder ? ' rvi-timeline__row--placeholder' : ''
              }`}
            >
              <span
                className="rvi-timeline__kind-text"
                style={{ width: 20, textAlign: 'center' }}
              >
                {idx + 1}
              </span>
              <span className="rvi-timeline__kind" aria-hidden>
                <KindIcon kind={item.kind} />
              </span>
              <span className="rvi-timeline__kind-text">{kindLabel(item.kind)}</span>
              <span
                className={`rvi-timeline__title${
                  isPlaceholder ? ' rvi-timeline__title--placeholder' : ''
                }`}
                title={item.label}
              >
                {item.label}
              </span>
              <span className="rvi-timeline__distance">
                {formatDistance(item.distanceKm)}
              </span>
              <span className="rvi-timeline__actions">
                <button
                  type="button"
                  className={`rvi-timeline__action${
                    item.visible === false ? '' : ' is-visible'
                  }`}
                  onClick={() => onToggleItem?.(item.id, !(item.visible !== false))}
                  aria-label="Afficher/masquer"
                >
                  <IconEye size={14} />
                </button>
                <button
                  type="button"
                  className={`rvi-timeline__action${item.favorite ? ' is-on' : ''}`}
                  onClick={() => onFavoriteItem?.(item.id, !item.favorite)}
                  aria-label="Favori"
                >
                  <IconStar size={14} />
                </button>
                <button
                  type="button"
                  className="rvi-timeline__action"
                  onClick={() => onRemoveItem?.(item.id)}
                  aria-label="Supprimer"
                >
                  <IconTrash size={14} />
                </button>
              </span>
            </div>
          );
        })}

        <button type="button" className="rvi-timeline__add" onClick={onAdd}>
          <span className="rvi-timeline__kind" aria-hidden>
            <IconPlus size={12} />
          </span>
          <span className="rvi-timeline__add-text">Ajouter un élément</span>
          <IconChevronDown size={14} style={{ marginLeft: 'auto', opacity: 0.6 }} />
        </button>
      </div>
    </section>
  );
}
