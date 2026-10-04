import { KindBadge } from './KindBadge';
import type { TimelineKindMenuOption } from './TimelineKindMenu';

/**
 * Types offered by the feuille de route's "+" menu, also used by the center
 * toolbar's "Ajouter" (placed on the chart). Labels are translated by the menu.
 */
export const TIMELINE_ADD_MENU_OPTIONS: readonly TimelineKindMenuOption[] = [
  {
    value: 'step',
    label: 'Étape',
    icon: <span className="rvi-tl-kind-menu__step-dot" />,
  },
  {
    value: 'waypoint',
    label: 'Waypoint',
    icon: <KindBadge kind="waypoint" />,
  },
  {
    value: 'poi',
    label: 'POI',
    icon: <KindBadge kind="poi" />,
  },
  {
    value: 'pause',
    label: 'Pause',
    icon: <KindBadge kind="pause" />,
  },
  {
    value: 'start',
    label: 'Départ',
    icon: <KindBadge kind="start" />,
  },
  {
    value: 'end',
    label: 'Destination',
    icon: <KindBadge kind="end" />,
  },
];
