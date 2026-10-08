import { KindBadge } from './KindBadge';
import type { TimelineKindMenuOption } from './TimelineKindMenu';

/**
 * Types proposés par le menu « + » de la feuille de route, utilisés aussi par
 * « Ajouter » de la barre d'outils centrale (posé sur le graphique). Les
 * libellés sont traduits par le menu.
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
