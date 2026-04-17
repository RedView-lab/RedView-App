/**
 * Colored circular badge used as the "Type" icon inside a timeline item.
 *
 * Matches the Figma sheet/timeline layout (nodes 1539:20638 / 1539:21068):
 *   - Départ   → white flag-pole marker
 *   - Fin      → checkered flag marker
 *   - Waypoint → red dot
 *   - Eau      → blue pin (circle + droplet + tooltip tail)
 *   - Super…   → orange pin (circle + cart + tooltip tail)
 *   - Pause    → grey circle with a pause icon
 *
 * Colors and pin-tail geometry are driven by CSS (see `_timeline.css`) so the
 * badge stays purely declarative and future-proof for theming.
 */
import {
  IconCheckpointEnd,
  IconCheckpointFlag,
  IconDroplet,
  IconPauseCircle,
  IconShoppingCart,
} from '../../components/icons';
import type { TimelineItemKind } from '../../types';

interface KindBadgeProps {
  kind: TimelineItemKind;
}

/** Visible French label matching the Figma mocks. */
export function kindLabel(kind: TimelineItemKind): string {
  switch (kind) {
    case 'start':
      return 'Départ';
    case 'end':
      return 'Fin';
    case 'waypoint':
      return 'Waypoint';
    case 'water':
      return 'Eau';
    case 'supermarket':
      return 'Supermarché';
    case 'pause':
      return 'Pause';
    default:
      return '';
  }
}

export function KindBadge({ kind }: KindBadgeProps) {
  if (kind === 'start') {
    return (
      <span className="rvi-kind rvi-kind--start" aria-hidden>
        <IconCheckpointFlag size={20} />
      </span>
    );
  }
  if (kind === 'end') {
    return (
      <span className="rvi-kind rvi-kind--end" aria-hidden>
        <IconCheckpointEnd size={20} />
      </span>
    );
  }
  if (kind === 'waypoint') {
    return (
      <span className="rvi-kind rvi-kind--waypoint" aria-hidden>
        <span className="rvi-kind__dot" />
      </span>
    );
  }
  if (kind === 'water') {
    return (
      <span className="rvi-kind rvi-kind--water rvi-kind--pinned" aria-hidden>
        <span className="rvi-kind__circle">
          <IconDroplet size={10} />
        </span>
        <span className="rvi-kind__tail" />
      </span>
    );
  }
  if (kind === 'supermarket') {
    return (
      <span className="rvi-kind rvi-kind--supermarket rvi-kind--pinned" aria-hidden>
        <span className="rvi-kind__circle">
          <IconShoppingCart size={10} />
        </span>
        <span className="rvi-kind__tail" />
      </span>
    );
  }
  if (kind === 'pause') {
    return (
      <span className="rvi-kind rvi-kind--pause" aria-hidden>
        <span className="rvi-kind__circle">
          <IconPauseCircle size={12} />
        </span>
      </span>
    );
  }
  return <span className="rvi-kind" aria-hidden />;
}
