import type { PopupOptions } from 'mapbox-gl';

type PopupOffset = NonNullable<PopupOptions['offset']>;

/** Emprise à l'écran d'un marqueur autour de son ancre géographique (px). */
export interface MarkerClearance {
  /** Étendue au-dessus de l'ancre. */
  above: number;
  /** Étendue en dessous de l'ancre. */
  below: number;
  /** Demi-largeur (à gauche / à droite de l'ancre). */
  side: number;
}

/**
 * Décalage de popup Mapbox par ancre, qui écarte la popup de son marqueur.
 *
 * Mapbox choisit seul l'ancre de la popup (au-dessus du point par défaut, en
 * dessous / à côté près des bords de la vue). Un décalage `[x, y]` unique est
 * appliqué tel quel à toutes les ancres : un décalage réglé pour un côté pousse
 * la popup SUR le marqueur dès que Mapbox retourne l'ancre. Cette table éloigne
 * chaque ancre du marqueur de son emprise de ce côté ; les ancres de coin se
 * dégagent verticalement (la popup s'étend alors sur le côté, loin du marqueur).
 */
export function buildPopupClearanceOffset(clearance: MarkerClearance, gapPx = 8): PopupOffset {
  const above = Math.round(clearance.above + gapPx);
  const below = Math.round(clearance.below + gapPx);
  const side = Math.round(clearance.side + gapPx);
  return {
    center: [0, 0],
    top: [0, below],
    'top-left': [0, below],
    'top-right': [0, below],
    bottom: [0, -above],
    'bottom-left': [0, -above],
    'bottom-right': [0, -above],
    left: [side, 0],
    right: [-side, 0],
  };
}
