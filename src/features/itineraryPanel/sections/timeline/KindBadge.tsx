/**
 * Colored kind badge — teardrop "pin" containing an icon, plus the flag /
 * dot variants for Départ / Fin / Waypoint.
 *
 * Visual reference: Figma 1539:20638 + the screenshots in the chat thread.
 *   - Départ      → vertical pole with white triangle flag
 *   - Fin         → black teardrop pin with checkered flag inside
 *   - Waypoint    → red filled dot with subtle ring
 *   - Eau         → blue (#1e5fc7) teardrop pin with white droplet inside
 *   - Supermarché → orange (#a85a1a) teardrop pin with white cart inside
 *   - Pause       → flat dark circle with pause icon
 */
import {
  IconCheckpointFlag,
  IconDroplet,
  IconFlagCheckered,
  IconPauseCircle,
  IconPinShape,
  IconShoppingCart,
} from '../../components/icons';
import type { TimelineItemKind } from '../../types';

interface KindBadgeProps {
  kind: TimelineItemKind;
  /** Pixel size of the badge (default 22 — matches Figma). */
  size?: number;
}

/** French labels matching the Figma mocks. */
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

/** Hex color used to fill each pin / dot. */
export const kindColor: Record<TimelineItemKind, string> = {
  start: '#ffffff',
  end: '#0e0e0e',
  waypoint: '#c50000',
  water: '#1e5fc7',
  supermarket: '#a85a1a',
  pause: '#3a3a3a',
};

interface PinWithIconProps {
  size: number;
  color: string;
  children: React.ReactNode;
}

/** Teardrop pin with an icon centered in the rounded "head". */
function PinWithIcon({ size, color, children }: PinWithIconProps) {
  return (
    <span className="rvi-kind__pin" style={{ width: size, height: size }}>
      <span className="rvi-kind__pin-shape" style={{ color }} aria-hidden>
        <IconPinShape size={size} />
      </span>
      <span className="rvi-kind__pin-icon" aria-hidden>
        {children}
      </span>
    </span>
  );
}

export function KindBadge({ kind, size = 22 }: KindBadgeProps) {
  if (kind === 'start') {
    return (
      <span
        className="rvi-kind rvi-kind--start"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconCheckpointFlag size={size} />
      </span>
    );
  }

  if (kind === 'end') {
    return (
      <span className="rvi-kind rvi-kind--end" aria-hidden>
        <PinWithIcon size={size} color={kindColor.end}>
          <IconFlagCheckered size={Math.round(size * 0.46)} />
        </PinWithIcon>
      </span>
    );
  }

  if (kind === 'waypoint') {
    return (
      <span
        className="rvi-kind rvi-kind--waypoint"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <span className="rvi-kind__dot" />
      </span>
    );
  }

  if (kind === 'water') {
    return (
      <span className="rvi-kind rvi-kind--water" aria-hidden>
        <PinWithIcon size={size} color={kindColor.water}>
          <IconDroplet size={Math.round(size * 0.5)} />
        </PinWithIcon>
      </span>
    );
  }

  if (kind === 'supermarket') {
    return (
      <span className="rvi-kind rvi-kind--supermarket" aria-hidden>
        <PinWithIcon size={size} color={kindColor.supermarket}>
          <IconShoppingCart size={Math.round(size * 0.5)} />
        </PinWithIcon>
      </span>
    );
  }

  if (kind === 'pause') {
    return (
      <span
        className="rvi-kind rvi-kind--pause"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <IconPauseCircle size={size} />
      </span>
    );
  }

  return <span className="rvi-kind" aria-hidden />;
}
