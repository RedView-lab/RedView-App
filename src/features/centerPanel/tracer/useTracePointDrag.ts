import { useEffect, useRef } from 'react';
import type { Map as MapboxMap, PointLike } from 'mapbox-gl';

import { isVariantModifierPressed } from '@/shared/lib/platform';
import { getMapScreenPoint } from '@/features/map3d/lib/mapPointer';
import {
  getTracePointControls,
  readTracePointDataset,
  TRACE_POINT_SELECTOR,
  type TracePointControls,
  type TracePointHandle,
} from '@/features/itineraryPanel/lib/tracer/tracePointDataset';
import type { TracePointKind } from '@/features/itineraryPanel/lib/tracer/traceEdits';
import {
  beginTracePointPress,
  draggedAnchorPoint,
  passesDragThreshold,
  type TracePointPress,
} from './tracePointGesture';

/**
 * Durée de vie du suppresseur du clic qui suit le relâchement. Le clic est
 * émis dans le même tour de boucle que le `mouseup` ; ce délai n'est qu'un
 * filet de sécurité si aucun clic n'arrive (relâchement hors du conteneur).
 * Compté depuis le relâchement : armé dès l'appui, il expirait pendant tout
 * glisser de plus de 120 ms et le clic final ajoutait une arrivée au tracé.
 */
const CLICK_SUPPRESSOR_TIMEOUT_MS = 300;

/** Fenêtre après un geste sur une poignée où un clic de carte n'est pas une action. */
const GESTURE_CLICK_GUARD_MS = 300;

/** Opacité du marqueur pendant le glisser : la trace reste visible dessous. */
const DRAGGING_OPACITY = '0.7';

let lastGestureEndAt = -Infinity;

/**
 * Vrai juste après un geste sur une poignée : un `click` de carte qui arrive
 * alors (rejoué, ou échappé au suppresseur) ne doit rien ajouter au tracé.
 */
export function isWithinTracePointGesture(now: number = performance.now()): boolean {
  return now - lastGestureEndAt < GESTURE_CLICK_GUARD_MS;
}

export type { TracePointKind };

export type TracePointDragTarget = TracePointHandle;

export interface TracePointDragCommit {
  target: TracePointDragTarget;
  lon: number;
  lat: number;
  /** Alt/Option (ou Cmd sur macOS) maintenu au relâchement. */
  variant: boolean;
}

interface UseTracePointDragArgs {
  map: MapboxMap | null;
  /** Coupé quand un outil qui consomme les clics de la carte est armé. */
  enabled: boolean;
  /** Applique le déplacement ; `false` = rien d'enregistré (le marqueur revient). */
  onCommit: (commit: TracePointDragCommit) => boolean;
  /** Notifie l'état du drag (utilisé pour le curseur). */
  onDraggingChange?: (dragging: boolean) => void;
}

interface PressSession {
  element: HTMLElement;
  target: TracePointDragTarget;
  controls: TracePointControls | null;
  press: TracePointPress;
  /** Échap, clic droit, fenêtre quittée : on attend le relâchement sans rien faire. */
  cancelled: boolean;
  restoreOpacity: string;
  restoreZIndex: string;
}

/**
 * Geste sur les poignées de tracé (départ, arrivée, étapes) de la carte, avec
 * ou sans outil Tracer armé :
 *   - clic : ouvre / ferme le panneau du point ;
 *   - glisser : le marqueur suit le pointeur, le point est déplacé au relâchement.
 *
 * Écoute en phase de capture sur le conteneur du canvas : les marqueurs sont
 * des éléments DOM placés dedans, on les cible par `closest()`. Le `mousedown`
 * est stoppé pour que Mapbox ne lance ni pan ni `click` de carte (qui
 * prolongerait le tracé) ; le panneau est donc ouvert ici, pas par Mapbox.
 */
export function useTracePointDrag({
  map,
  enabled,
  onCommit,
  onDraggingChange,
}: UseTracePointDragArgs): void {
  const onCommitRef = useRef(onCommit);
  const onDraggingChangeRef = useRef(onDraggingChange);
  useEffect(() => {
    onCommitRef.current = onCommit;
    onDraggingChangeRef.current = onDraggingChange;
  });

  useEffect(() => {
    if (!enabled || !map) return;

    // Alias non-nullable : la narrowing d'un paramètre est perdue dans les
    // closures, pas celle d'une `const`.
    const mapInstance: MapboxMap = map;
    const container = mapInstance.getCanvasContainer();

    let session: PressSession | null = null;
    /** On ne réactive `dragPan` que si c'est bien nous qui l'avons coupé. */
    let dragPanDisabledByUs = false;

    let clickSuppressor: ((event: MouseEvent) => void) | null = null;
    let suppressorTimer: number | null = null;

    let previewFrame: number | null = null;
    let previewPointer: { x: number; y: number } | null = null;

    const removeClickSuppressor = () => {
      if (suppressorTimer !== null) {
        window.clearTimeout(suppressorTimer);
        suppressorTimer = null;
      }
      if (!clickSuppressor) return;
      window.removeEventListener('click', clickSuppressor, true);
      clickSuppressor = null;
    };

    /** Avale le clic natif qui suit le relâchement : le geste a déjà agi. */
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
      suppressorTimer = window.setTimeout(removeClickSuppressor, CLICK_SUPPRESSOR_TIMEOUT_MS);
    };

    const unprojectAnchor = (current: PressSession, pointer: { x: number; y: number }) => {
      const anchor = draggedAnchorPoint(current.press, pointer);
      return mapInstance.unproject([anchor.x, anchor.y] as PointLike);
    };

    const cancelPreviewFrame = () => {
      if (previewFrame === null) return;
      window.cancelAnimationFrame(previewFrame);
      previewFrame = null;
    };

    const flushPreview = () => {
      previewFrame = null;
      const current = session;
      if (!current || !current.press.dragging || current.cancelled || !previewPointer) return;
      const lngLat = unprojectAnchor(current, previewPointer);
      current.controls?.preview({ lon: lngLat.lng, lat: lngLat.lat });
    };

    const setDragging = (dragging: boolean) => {
      onDraggingChangeRef.current?.(dragging);
    };

    const restoreDragPan = () => {
      if (!dragPanDisabledByUs) return;
      dragPanDisabledByUs = false;
      try {
        mapInstance.dragPan.enable();
      } catch {
        /* noop */
      }
    };

    const restoreElement = (current: PressSession) => {
      current.element.style.opacity = current.restoreOpacity;
      current.element.style.zIndex = current.restoreZIndex;
      current.element.style.cursor = '';
    };

    function endSession() {
      const current = session;
      if (!current) return;
      session = null;
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
      container.removeEventListener('contextmenu', handleContextMenu, true);
      cancelPreviewFrame();
      previewPointer = null;
      restoreElement(current);
      if (current.press.dragging) setDragging(false);
      restoreDragPan();
    }

    /** Abandon du geste : le marqueur revient, rien n'est enregistré. */
    function cancelSession() {
      const current = session;
      if (!current || current.cancelled) return;
      current.cancelled = true;
      cancelPreviewFrame();
      if (current.press.dragging) current.controls?.preview(null);
      restoreElement(current);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelSession();
    }

    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
      event.stopPropagation();
      cancelSession();
    }

    function handleBlur() {
      // Fenêtre quittée bouton enfoncé : aucun relâchement ne viendra.
      cancelSession();
      endSession();
    }

    function handleWindowMouseMove(event: MouseEvent) {
      const current = session;
      if (!current || current.cancelled) return;

      const client = { x: event.clientX, y: event.clientY };
      if (!current.press.dragging) {
        if (!passesDragThreshold(current.press, client)) return;
        current.press = { ...current.press, dragging: true };
        current.element.style.opacity = DRAGGING_OPACITY;
        current.element.style.zIndex = '200';
        setDragging(true);
      }

      event.preventDefault();
      previewPointer = getMapScreenPoint(mapInstance, event.clientX, event.clientY);
      if (previewFrame === null) previewFrame = window.requestAnimationFrame(flushPreview);
    }

    function handleWindowMouseUp(event: MouseEvent) {
      if (event.button !== 0) return;
      const current = session;
      if (!current) return;

      suppressNextClick();
      lastGestureEndAt = performance.now();
      const wasDragging = current.press.dragging;
      const pointer = getMapScreenPoint(mapInstance, event.clientX, event.clientY);
      endSession();
      if (current.cancelled) return;

      if (!wasDragging) {
        current.controls?.togglePanel();
        return;
      }

      const lngLat = unprojectAnchor(current, pointer);
      current.controls?.preview({ lon: lngLat.lng, lat: lngLat.lat });
      const recorded = onCommitRef.current({
        target: current.target,
        lon: lngLat.lng,
        lat: lngLat.lat,
        variant: isVariantModifierPressed(event),
      });
      // Rien d'enregistré : aucun rendu ne replacera le marqueur, on le fait ici.
      if (!recorded) current.controls?.preview(null);
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || session) return;

      const source = event.target as HTMLElement | null;
      const handle = source?.closest?.<HTMLElement>(TRACE_POINT_SELECTOR) ?? null;
      if (!handle) return;

      const parsed = readTracePointDataset(handle.dataset);
      if (!parsed) return;

      // Stoppe Mapbox (pan + click de carte). Le clic natif qui suivra est
      // avalé au relâchement : c'est le geste qui ouvre le panneau.
      event.stopPropagation();

      const controls = getTracePointControls(handle);
      const pointer = getMapScreenPoint(mapInstance, event.clientX, event.clientY);
      session = {
        element: handle,
        target: parsed,
        controls,
        press: beginTracePointPress(
          { x: event.clientX, y: event.clientY },
          pointer,
          controls?.anchorPoint() ?? null,
        ),
        cancelled: false,
        restoreOpacity: handle.style.opacity,
        restoreZIndex: handle.style.zIndex,
      };
      handle.style.cursor = 'grabbing';

      try {
        mapInstance.dragPan.disable();
        dragPanDisabledByUs = true;
      } catch {
        /* noop */
      }

      window.addEventListener('mousemove', handleWindowMouseMove, true);
      window.addEventListener('mouseup', handleWindowMouseUp, true);
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('blur', handleBlur);
      container.addEventListener('contextmenu', handleContextMenu, true);
    };

    container.addEventListener('mousedown', handleMouseDown, true);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
      cancelSession();
      endSession();
      removeClickSuppressor();
    };
  }, [enabled, map]);
}
