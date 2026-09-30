import type { Map as MapboxMap } from 'mapbox-gl';

import { queryPoiAtPoint } from '@/features/poi/lib/poi-markers';
import { getMapScreenPoint, unprojectClientPoint } from '@/features/map3d/lib/mapPointer';
import {
  MAP_CURSOR_PRIORITY,
  handlePointPanelMousedown,
  isPointPanelOpen,
  setMapCursor,
} from '@/features/map3d';
import {
  clearRouteHoverPreview,
  setRouteHoverPreview,
} from '@/features/itineraryPanel/lib/route-layer';
import { isVariantModifierPressed } from '@/shared/lib/platform';
import { findRouteGrabHit, type RouteGrabHit } from './routeDragWaypointSnap';

/**
 * Pointeur du mode Tracer sur la trace active : survol, clic et drag.
 *
 * Une seule règle décide de tout — `classify()` — et sert à la fois au curseur
 * affiché et à l'action du clic : ce que montre le curseur est exactement ce
 * que fait le clic.
 *
 *   - `route` (main)    : l'appui saisit la trace. Clic = point de passage au
 *                         point d'aperçu ; glisser = point de passage déposé au
 *                         relâchement.
 *   - `poi`   (pointer) : le pointeur est sur l'icône d'un POI, son clic l'ouvre.
 *   - `trace` (crayon)  : curseur de l'outil Tracer, le clic prolonge le tracé
 *                         (géré par TraceToolContext via le `click` Mapbox).
 *
 * Anti-clignotement :
 *   - un seul écrivain du curseur, l'arbitre `setMapCursor` ;
 *   - survol évalué de façon synchrone dans le `mousemove` (pas une frame plus
 *     tard) : le canvas porte déjà le bon curseur quand le pointeur y revient ;
 *   - sur un élément DOM (marqueur, poignée, alerte…) l'état est figé : c'est
 *     l'élément qui fixe son curseur, et le canvas garde le sien pour le retour ;
 *   - hystérésis spatiale (seuils entrée / sortie de `findRouteGrabHit`) ;
 *   - intention : depuis le crayon, la main (ou le pointer d'un POI) n'apparaît
 *     que si le pointeur ralentit sous INTENT_MAX_SPEED_PX_S ou s'arrête. Une
 *     approche visée est instantanée ; traverser la trace d'un geste ne fait
 *     jamais flasher la main, quelle que soit la largeur de la zone.
 */

type HoverState = 'trace' | 'route' | 'poi';

export interface RouteEditPoint {
  lat: number;
  lon: number;
}

export interface RouteEditPointerDeps {
  /** Géométrie de la trace active (null / < 2 points : rien à saisir). */
  getRoutePoints: () => Array<{ lat: number; lon: number }> | null;
  /** Style du point d'aperçu (couleur de la trace, rayon). */
  getPreviewStyle: () => { color?: string; radius: number };
  /** Point de passage à insérer : saisi en `anchor` sur la trace, déposé en `drop`. */
  onCommit: (anchor: RouteEditPoint, drop: RouteEditPoint, asVariant: boolean) => void;
  onDraggingChange: (dragging: boolean) => void;
}

export interface RouteEditPointerController {
  /** Réévalue le survol au dernier emplacement connu (trace recalculée, caméra déplacée). */
  refresh: () => void;
  destroy: () => void;
}

const HOVER_CURSOR_OWNER = 'route-edit-hover';
const DRAG_CURSOR_OWNER = 'route-edit-drag';

/** Déplacement minimal (px) avant qu'un appui sur la trace devienne un drag. */
const DRAG_THRESHOLD_PX = 4;
/**
 * Au-delà de cette vitesse, le pointeur traverse sans viser : on ne quitte pas
 * le crayon. On vise en ralentissant (loi de Fitts), bien en dessous.
 */
const INTENT_MAX_SPEED_PX_S = 700;
/** Sans mouvement pendant ce délai, le pointeur est considéré arrêté. */
const POINTER_SETTLE_MS = 45;
/** Filet de sécurité : durée de vie max du suppresseur du clic qui suit l'appui. */
const CLICK_SUPPRESSOR_TIMEOUT_MS = 300;

interface PressSession {
  anchor: RouteEditPoint;
  startX: number;
  startY: number;
  dragging: boolean;
  /** Échap / clic droit : on attend le relâchement sans rien insérer. */
  cancelled: boolean;
}

export function createRouteEditPointer(
  map: MapboxMap,
  deps: RouteEditPointerDeps,
): RouteEditPointerController {
  const canvas = map.getCanvas();
  const container = map.getCanvasContainer();

  let shown: HoverState = 'trace';
  /** La main était affichée avant de passer sur un POI : on garde le seuil de sortie. */
  let stickyRoute = false;
  /** État brut du dernier échantillon sur le canvas (null : sur un élément DOM, hors carte). */
  let previousRaw: HoverState | null = null;
  /** Une cible est sous le pointeur mais il file encore : on attend qu'il ralentisse. */
  let intentPending = false;
  let settleTimer: number | null = null;

  let pointer: { clientX: number; clientY: number } | null = null;
  let pointerOnCanvas = false;
  let buttonsDown = 0;

  let lastSample: { x: number; y: number; t: number } | null = null;
  let pointerSpeed = 0;

  let session: PressSession | null = null;

  let clickSuppressor: ((event: MouseEvent) => void) | null = null;
  let clickSuppressorTimer: number | null = null;

  // ── Point d'aperçu (couche GeoJSON) : écrit au plus une fois par frame ──
  let previewTarget: RouteEditPoint | null = null;
  let previewWritten: RouteEditPoint | null = null;
  let previewFrame: number | null = null;

  const flushPreview = () => {
    previewFrame = null;
    const target = previewTarget;
    if (target) {
      if (previewWritten && previewWritten.lon === target.lon && previewWritten.lat === target.lat) return;
      const style = deps.getPreviewStyle();
      setRouteHoverPreview(map, { lon: target.lon, lat: target.lat, color: style.color, radius: style.radius });
    } else if (previewWritten) {
      clearRouteHoverPreview(map);
    }
    previewWritten = target;
  };

  const showPreview = (target: RouteEditPoint | null) => {
    previewTarget = target;
    if (previewFrame === null) previewFrame = window.requestAnimationFrame(flushPreview);
  };

  // ── Vitesse du pointeur ──

  const trackSpeed = (x: number, y: number) => {
    const t = performance.now();
    if (lastSample) {
      const dt = Math.max(4, t - lastSample.t);
      const instant = (Math.hypot(x - lastSample.x, y - lastSample.y) / dt) * 1000;
      // Lissage léger : un échantillon isolé (événements regroupés) ne décide pas seul.
      pointerSpeed = dt > 100 ? instant : pointerSpeed * 0.4 + instant * 0.6;
    }
    lastSample = { x, y, t };
  };

  const currentSpeed = () =>
    lastSample && performance.now() - lastSample.t < POINTER_SETTLE_MS ? pointerSpeed : 0;

  const resetSpeed = () => {
    lastSample = null;
    pointerSpeed = 0;
  };

  // ── État affiché ──

  const cancelIntent = () => {
    intentPending = false;
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  /** Réévalue dès que le pointeur est considéré arrêté. */
  const scheduleSettle = () => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      evaluate();
    }, POINTER_SETTLE_MS + 1);
  };

  const commit = (state: HoverState, hit: RouteGrabHit | null) => {
    if (state !== shown) {
      shown = state;
      if (state === 'route') stickyRoute = true;
      else if (state === 'trace') stickyRoute = false;
      setMapCursor(
        map,
        HOVER_CURSOR_OWNER,
        state === 'route' ? 'grab' : state === 'poi' ? 'pointer' : null,
        MAP_CURSOR_PRIORITY.hover,
      );
    }
    showPreview(state === 'route' && hit ? hit.snapped : null);
  };

  const classify = (clientX: number, clientY: number): { state: HoverState; hit: RouteGrabHit | null } => {
    // Un panneau de point ouvert : le prochain clic sur la carte ne fait que le fermer.
    if (isPointPanelOpen(canvas)) return { state: 'trace', hit: null };

    const point = getMapScreenPoint(map, clientX, clientY);
    // Même test (rayon 0) que le survol / clic de la couche POI elle-même.
    if (queryPoiAtPoint(map, point)) return { state: 'poi', hit: null };

    const points = deps.getRoutePoints();
    if (points && points.length >= 2) {
      const mode = shown === 'route' || (shown === 'poi' && stickyRoute) ? 'exit' : 'enter';
      const hit = findRouteGrabHit(map, points, point.x, point.y, mode);
      if (hit) return { state: 'route', hit };
    }
    return { state: 'trace', hit: null };
  };

  /** Échantillon du pointeur sur le canvas → état affiché. */
  function evaluate() {
    if (session || !pointer || !pointerOnCanvas || buttonsDown !== 0) return;

    const { state, hit } = classify(pointer.clientX, pointer.clientY);
    // Quitter le crayon en glissant sur le canvas demande une intention. En
    // revanche, arriver d'un marqueur DOM ou de hors carte bascule directement.
    const leavingPencil = shown === 'trace' && state !== 'trace'
      && (intentPending || previousRaw === 'trace');
    previousRaw = state;

    if (leavingPencil && currentSpeed() > INTENT_MAX_SPEED_PX_S) {
      intentPending = true;
      scheduleSettle();
      return;
    }

    cancelIntent();
    commit(state, hit);
  }

  /** Le pointeur n'est plus sur le canvas : on fige l'état affiché, sans aperçu. */
  const freeze = () => {
    previousRaw = null;
    cancelIntent();
    showPreview(null);
  };

  // ── Suppression du clic qui suit un appui sur la trace ──
  // Sans elle, Mapbox émettrait son `click` de carte (son `mousedown` a été
  // stoppé, il ne sait pas qu'il y a eu un geste) et l'outil Tracer ajouterait
  // en plus un point au bout du tracé.

  const removeClickSuppressor = () => {
    if (clickSuppressorTimer !== null) {
      window.clearTimeout(clickSuppressorTimer);
      clickSuppressorTimer = null;
    }
    if (!clickSuppressor) return;
    window.removeEventListener('click', clickSuppressor, true);
    clickSuppressor = null;
  };

  const suppressNextClick = () => {
    removeClickSuppressor();
    clickSuppressor = (event: MouseEvent) => {
      removeClickSuppressor();
      if (!(event.target instanceof Node) || !container.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener('click', clickSuppressor, true);
    clickSuppressorTimer = window.setTimeout(removeClickSuppressor, CLICK_SUPPRESSOR_TIMEOUT_MS);
  };

  // ── Geste sur la trace ──

  const setSessionDragging = (dragging: boolean) => {
    setMapCursor(map, DRAG_CURSOR_OWNER, dragging ? 'grabbing' : null, MAP_CURSOR_PRIORITY.gesture);
    deps.onDraggingChange(dragging);
  };

  const endSession = () => {
    const current = session;
    if (!current) return;
    session = null;
    window.removeEventListener('mousemove', handleSessionMouseMove, true);
    window.removeEventListener('mouseup', handleSessionMouseUp, true);
    window.removeEventListener('keydown', handleSessionKeyDown, true);
    window.removeEventListener('blur', handleSessionBlur);
    container.removeEventListener('contextmenu', handleSessionContextMenu, true);
    if (current.dragging) setSessionDragging(false);
  };

  const cancelSession = () => {
    const current = session;
    if (!current || current.cancelled) return;
    current.cancelled = true;
    if (current.dragging) {
      current.dragging = false;
      setSessionDragging(false);
    }
    showPreview(null);
  };

  function handleSessionMouseMove(event: MouseEvent) {
    const current = session;
    if (!current) return;
    pointer = { clientX: event.clientX, clientY: event.clientY };
    if (current.cancelled) return;

    if (!current.dragging) {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (distance < DRAG_THRESHOLD_PX) return;
      current.dragging = true;
      setSessionDragging(true);
    }

    event.preventDefault();
    const lngLat = unprojectClientPoint(map, event.clientX, event.clientY);
    showPreview({ lon: lngLat.lng, lat: lngLat.lat });
  }

  function handleSessionMouseUp(event: MouseEvent) {
    if (event.button !== 0) return;
    const current = session;
    if (!current) return;

    endSession();
    suppressNextClick();
    pointer = { clientX: event.clientX, clientY: event.clientY };
    pointerOnCanvas = event.target === canvas;
    buttonsDown = event.buttons;

    if (!current.cancelled) {
      const asVariant = isVariantModifierPressed(event);
      if (current.dragging) {
        const drop = unprojectClientPoint(map, event.clientX, event.clientY);
        deps.onCommit(current.anchor, { lat: drop.lat, lon: drop.lng }, asVariant);
      } else {
        // Clic simple : le point de passage tombe exactement sur le point d'aperçu.
        deps.onCommit(current.anchor, current.anchor, asVariant);
      }
    }

    // Recale tout de suite le curseur là où le bouton a été relâché.
    if (pointerOnCanvas) {
      previousRaw = null;
      evaluate();
    } else {
      freeze();
    }
  }

  function handleSessionKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancelSession();
  }

  function handleSessionContextMenu(event: MouseEvent) {
    // Clic droit pendant le geste : annule le geste, sans quitter l'outil Tracer.
    event.preventDefault();
    event.stopPropagation();
    cancelSession();
  }

  function handleSessionBlur() {
    // Fenêtre quittée bouton enfoncé : aucun relâchement ne viendra.
    cancelSession();
    endSession();
  }

  // ── Écouteurs du conteneur de la carte ──

  const handleMouseDown = (event: MouseEvent) => {
    buttonsDown = event.buttons;
    if (event.button !== 0 || session) return;
    pointer = { clientX: event.clientX, clientY: event.clientY };

    // Marqueurs, poignées, alertes… : ils gèrent eux-mêmes leur appui.
    if (event.target !== canvas) return;
    pointerOnCanvas = true;

    if (isPointPanelOpen(canvas)) {
      handlePointPanelMousedown(canvas);
      return;
    }

    // Décision prise au point exact de l'appui, avec la règle du survol.
    const { state, hit } = classify(event.clientX, event.clientY);
    if (state !== 'route' || !hit) return; // POI : son clic ; ailleurs : prolongement ou pan.

    // Ni pan Mapbox, ni sélection de texte.
    event.preventDefault();
    event.stopPropagation();

    previousRaw = 'route';
    cancelIntent();
    commit('route', hit);

    session = {
      anchor: hit.snapped,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      cancelled: false,
    };
    window.addEventListener('mousemove', handleSessionMouseMove, true);
    window.addEventListener('mouseup', handleSessionMouseUp, true);
    window.addEventListener('keydown', handleSessionKeyDown, true);
    window.addEventListener('blur', handleSessionBlur);
    container.addEventListener('contextmenu', handleSessionContextMenu, true);
  };

  const handleMouseMove = (event: MouseEvent) => {
    pointer = { clientX: event.clientX, clientY: event.clientY };
    buttonsDown = event.buttons;
    trackSpeed(event.clientX, event.clientY);
    if (session) return;

    pointerOnCanvas = event.target === canvas;
    if (!pointerOnCanvas || buttonsDown !== 0) {
      // Sur un élément DOM, ou pendant un pan : état figé, pas d'aperçu.
      freeze();
      return;
    }
    evaluate();
  };

  const handleMouseLeave = () => {
    if (session) return;
    pointer = null;
    pointerOnCanvas = false;
    resetSpeed();
    freeze();
    commit('trace', null);
  };

  const handleWindowMouseUp = (event: MouseEvent) => {
    buttonsDown = event.buttons;
  };

  const handleMoveEnd = () => {
    evaluate();
  };

  container.addEventListener('mousedown', handleMouseDown, true);
  container.addEventListener('mousemove', handleMouseMove, true);
  container.addEventListener('mouseleave', handleMouseLeave);
  window.addEventListener('mouseup', handleWindowMouseUp, true);
  map.on('moveend', handleMoveEnd);

  return {
    refresh: evaluate,
    destroy: () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
      container.removeEventListener('mousemove', handleMouseMove, true);
      container.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      map.off('moveend', handleMoveEnd);

      endSession();
      removeClickSuppressor();
      cancelIntent();
      if (previewFrame !== null) {
        window.cancelAnimationFrame(previewFrame);
        previewFrame = null;
      }
      clearRouteHoverPreview(map);
      setMapCursor(map, HOVER_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.hover);
      setMapCursor(map, DRAG_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.gesture);
    },
  };
}
