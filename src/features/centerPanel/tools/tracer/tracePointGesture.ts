/**
 * Géométrie du geste sur une poignée de tracé (départ, arrivée, étape), sans
 * DOM ni carte : seuil du glisser et décalage de saisie.
 *
 * Le point déposé est l'ancre du marqueur, pas le pointeur : saisi par le haut
 * de son drapeau (ancre en bas), un départ tombait ~30 px plus bas que le
 * marqueur qu'on voyait suivre la souris.
 */

/** Déplacement minimal (px) avant qu'un appui soit traité comme un glisser. */
export const TRACE_POINT_DRAG_THRESHOLD_PX = 4;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface TracePointPress {
  /** Position client de l'appui (seuil du glisser). */
  startClient: ScreenPoint;
  /** Ancre du marqueur moins pointeur, en px du conteneur de carte. */
  grabOffset: ScreenPoint;
  dragging: boolean;
}

/** `anchor` : ancre du marqueur (px du conteneur) ; absente, on dépose sous le pointeur. */
export function beginTracePointPress(
  client: ScreenPoint,
  pointer: ScreenPoint,
  anchor: ScreenPoint | null,
): TracePointPress {
  const grabOffset = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
    ? { x: anchor.x - pointer.x, y: anchor.y - pointer.y }
    : { x: 0, y: 0 };
  return { startClient: { ...client }, grabOffset, dragging: false };
}

/** Le pointeur a-t-il assez bougé pour que l'appui devienne un glisser ? */
export function passesDragThreshold(press: TracePointPress, client: ScreenPoint): boolean {
  if (press.dragging) return true;
  return Math.hypot(client.x - press.startClient.x, client.y - press.startClient.y)
    >= TRACE_POINT_DRAG_THRESHOLD_PX;
}

/** Position de l'ancre du marqueur pour ce pointeur (px du conteneur). */
export function draggedAnchorPoint(press: TracePointPress, pointer: ScreenPoint): ScreenPoint {
  return { x: pointer.x + press.grabOffset.x, y: pointer.y + press.grabOffset.y };
}
