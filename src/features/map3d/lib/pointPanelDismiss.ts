/**
 * Gestion de la fermeture des panneaux de point de la carte (popup de POI, popup
 * de point de passage, popup de pause sur / hors itinéraire, carte de brouillon
 * de POI, menu contextuel, etc.).
 *
 * Garantit que lorsque l'utilisateur clique sur la carte pour fermer un panneau
 * de point ouvert, ce clic ne fait QUE fermer le panneau et NE déclenche AUCUNE
 * autre action de planification (comme ajouter un point de tracé ou créer un
 * point de passage par glisser).
 */

let isPressDismissingPointPanel = false;
let lastPointPanelDismissTimestamp = 0;

/**
 * Renvoie true si un panneau de point ou une popup interactifs sont ouverts dans
 * le DOM et que la cible (si elle est fournie) n'est pas dans ce panneau.
 */
export function isPointPanelOpen(target?: EventTarget | null): boolean {
  if (typeof document === 'undefined') return false;

  if (target instanceof Element) {
    if (
      target.closest(
        '.mapboxgl-popup, .rv-poi-draft-card, [data-rv-poi-draft-card], .rv-checkpoint-popup, .rv-poi-popup, .rv-map-context-menu, [data-rv-comment-card]',
      )
    ) {
      return false;
    }
  }

  // 1. Toute popup Mapbox attachée au DOM (POI, point de contrôle, point de passage, pause, recherche)
  const popups = document.querySelectorAll('.mapboxgl-popup');
  for (const el of popups) {
    if (el instanceof HTMLElement && el.offsetParent !== null) {
      return true;
    }
  }

  // 2. Carte de POI en brouillon
  const draftCard = document.querySelector('.rv-poi-draft-card, [data-rv-poi-draft-card]');
  if (draftCard instanceof HTMLElement && draftCard.offsetParent !== null) {
    return true;
  }

  // 3. Menu contextuel (clic droit) de la carte
  const contextMenu = document.querySelector('.rv-map-context-menu');
  if (contextMenu instanceof HTMLElement && contextMenu.offsetParent !== null) {
    return true;
  }

  // 4. Fil de commentaires ouvert ou nouveau commentaire (features/comments)
  const commentCard = document.querySelector('[data-rv-comment-card]');
  if (commentCard instanceof HTMLElement && commentCard.offsetParent !== null) {
    return true;
  }

  return false;
}

/**
 * À appeler sur `mousedown` sur la carte ou le canvas. Si un panneau de point
 * est ouvert, note que cette séquence d'appui sert à fermer le panneau.
 */
export function handlePointPanelMousedown(target: EventTarget | null): boolean {
  if (isPointPanelOpen(target)) {
    isPressDismissingPointPanel = true;
    lastPointPanelDismissTimestamp = Date.now();
    return true;
  }
  return false;
}

/**
 * À appeler dans les handlers de `click` (p. ex. TraceToolContext,
 * RouteDragWaypointContext, RouteSplitToolContext). Renvoie true si ce clic a
 * servi à fermer un panneau de point : le clic doit alors être ignoré et ne
 * faire AUCUNE action.
 */
export function shouldIgnoreMapClickAfterPanelDismiss(
  target: EventTarget | null,
  thresholdMs: number = 400,
): boolean {
  if (isPressDismissingPointPanel) {
    isPressDismissingPointPanel = false;
    lastPointPanelDismissTimestamp = Date.now();
    return true;
  }

  if (Date.now() - lastPointPanelDismissTimestamp < thresholdMs) {
    return true;
  }

  if (isPointPanelOpen(target)) {
    lastPointPanelDismissTimestamp = Date.now();
    return true;
  }

  return false;
}

/**
 * Fait qu'un second clic sur un marqueur dont la popup est ouverte ferme cette popup.
 *
 * Mapbox ferme une popup `closeOnClick` sur `preclick`, puis le marqueur la
 * rouvre sur `click` : recliquer sur un marqueur ouvert gardait son panneau
 * ouvert. Cet écouteur s'exécute avant celui de la carte (remontée, élément
 * enfant) : il ferme le panneau et s'arrête là.
 */
export function closeMarkerPopupOnSecondClick(
  element: HTMLElement,
  popup: { isOpen: () => boolean; remove: () => unknown },
): void {
  element.addEventListener('click', (event) => {
    if (!popup.isOpen()) return;
    event.stopPropagation();
    popup.remove();
  });
}

/** Marqueurs DOM posés sur la carte (checkpoints, waypoints, pauses, POI DOM). */
const DOM_MARKER_SELECTOR = '.mapboxgl-marker, .rv-poi-marker, .rv-checkpoint-marker';

/**
 * Vrai quand l'événement (DOM, ou `MapMouseEvent` via `originalEvent`) part
 * d'un marqueur DOM. Mapbox émet quand même ses événements de couche
 * (`map.on('click', layerId)`) si un symbole se trouve sous le marqueur : un
 * waypoint posé sur un POI ouvrait ainsi son panneau ET celui du POI.
 */
export function isEventFromDomMarker(
  event: Event | { originalEvent?: Event | null } | null | undefined,
): boolean {
  if (!event) return false;
  const target = event instanceof Event ? event.target : event.originalEvent?.target;
  return target instanceof Element && target.closest(DOM_MARKER_SELECTOR) !== null;
}
