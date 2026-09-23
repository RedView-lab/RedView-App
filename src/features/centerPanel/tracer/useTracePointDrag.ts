import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { isVariantModifierPressed } from '@/shared/lib/platform';
import { unprojectMouseEvent } from '@/features/map3d/lib/mapPointer';
import {
  readTracePointDataset,
  TRACE_POINT_SELECTOR,
  type TracePointHandle,
} from '@/features/itineraryPanel/lib/tracer/tracePointDataset';
import type { TracePointKind } from '@/features/itineraryPanel/lib/tracer/traceEdits';

/** Déplacement minimal (px) avant qu'un appui soit traité comme un drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Fenêtre pendant laquelle on avale le clic naturel qui suit un `mouseup` sur
 * une poignée. Le clic est normalement émis dans le même tour de boucle que le
 * `mouseup` ; ce délai n'est qu'un filet de sécurité si aucun clic n'arrive
 * (relâchement hors de l'élément), pour ne jamais laisser traîner le listener.
 */
const CLICK_SUPPRESSOR_TIMEOUT_MS = 120;

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
  /** Le drag n'est actif que lorsque l'outil Tracer est armé. */
  armed: boolean;
  onCommit: (commit: TracePointDragCommit) => void;
  /** Notifie l'état du drag (utilisé pour le curseur). */
  onDraggingChange?: (dragging: boolean) => void;
}

/**
 * Rend déplaçables les poignées de tracé (départ, arrivée, waypoints) pendant
 * que l'outil Tracer est armé.
 *
 * Écoute en phase de capture sur le conteneur du canvas : les marqueurs sont des
 * éléments DOM placés dedans, on peut donc les cibler par `closest()` sans
 * refaire de hit-test écran. Le `mousedown` est stoppé pour que Mapbox ne
 * déclenche ni son pan ni son `click` de carte (qui ajouterait un point).
 */
export function useTracePointDrag({
  map,
  armed,
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
    if (!armed || !map) return;

    // Alias non-nullable : la narrowing d'un paramètre est perdue dans les
    // closures, pas celle d'une `const`.
    const mapInstance: MapboxMap = map;
    const container = mapInstance.getCanvasContainer();

    let element: HTMLElement | null = null;
    let target: TracePointDragTarget | null = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let restoreOpacity = '';
    let restoreZIndex = '';
    /** On ne réactive `dragPan` que si c'est bien nous qui l'avons coupé. */
    let dragPanDisabledByUs = false;

    let clickSuppressor: ((event: MouseEvent) => void) | null = null;
    let replayMarkerClick = false;
    let suppressorTimer: number | null = null;

    const removeClickSuppressor = () => {
      if (suppressorTimer !== null) {
        window.clearTimeout(suppressorTimer);
        suppressorTimer = null;
      }
      if (!clickSuppressor) return;
      container.removeEventListener('click', clickSuppressor, true);
      clickSuppressor = null;
    };

    /**
     * Avale le clic qui suit un appui sur une poignée. Sans ça, Mapbox
     * déclencherait son `click` de carte et ajouterait un point parasite.
     * Quand l'utilisateur n'a pas bougé, on rejoue nous-mêmes le clic du
     * marqueur pour que sa popup s'ouvre comme avant.
     */
    const installClickSuppressor = () => {
      removeClickSuppressor();
      clickSuppressor = (event: MouseEvent) => {
        if (replayMarkerClick) {
          replayMarkerClick = false;
          return;
        }
        event.stopPropagation();
        event.stopImmediatePropagation();
        event.preventDefault();
        removeClickSuppressor();
      };
      container.addEventListener('click', clickSuppressor, true);
      suppressorTimer = window.setTimeout(removeClickSuppressor, CLICK_SUPPRESSOR_TIMEOUT_MS);
    };

    const setDragging = (next: boolean) => {
      if (dragging === next) return;
      dragging = next;
      onDraggingChangeRef.current?.(next);
    };

    const restoreElement = () => {
      if (!element) return;
      element.style.opacity = restoreOpacity;
      element.style.zIndex = restoreZIndex;
      element.style.cursor = '';
      element = null;
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

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Échap annule : on ne commite rien.
      target = null;
      release();
    }

    function release() {
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      restoreElement();
      setDragging(false);
      target = null;
      restoreDragPan();
    }

    function handleWindowMouseMove(event: MouseEvent) {
      if (!target) return;

      if (!dragging) {
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (distance < DRAG_THRESHOLD_PX) return;
        setDragging(true);
        if (element) element.style.opacity = '0.45';
      }

      event.preventDefault();
    }

    function handleWindowMouseUp(event: MouseEvent) {
      if (event.button !== 0) return;

      const activeTarget = target;
      const wasDragging = dragging;
      const elementForReplay = element;
      release();

      if (!activeTarget) return;

      if (!wasDragging) {
        replayMarkerClick = true;
        elementForReplay?.click();
        return;
      }

      // Même conversion que `event.lngLat` de Mapbox (et donc que l'aperçu de
      // survol que l'utilisateur suivait) : `map.unproject` seul ignore le
      // conteneur réel et le facteur d'échelle CSS, ce qui faisait atterrir le
      // point à plusieurs centaines de mètres de la cible.
      const lngLat = unprojectMouseEvent(mapInstance, event);

      onCommitRef.current({
        target: activeTarget,
        lon: lngLat.lng,
        lat: lngLat.lat,
        variant: isVariantModifierPressed(event),
      });
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (target) return;

      const source = event.target as HTMLElement | null;
      const handle = source?.closest?.<HTMLElement>(TRACE_POINT_SELECTOR) ?? null;
      if (!handle) return;

      const parsed = readTracePointDataset(handle.dataset);
      if (!parsed) return;

      // Stoppe Mapbox (pan + click de carte). On ne `preventDefault` pas pour
      // laisser le clic du marqueur se produire : c'est le suppresseur qui
      // décide s'il faut le rejouer ou l'avaler.
      event.stopPropagation();

      element = handle;
      target = parsed;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      restoreOpacity = handle.style.opacity;
      restoreZIndex = handle.style.zIndex;
      handle.style.cursor = 'grabbing';

      installClickSuppressor();

      try {
        mapInstance.dragPan.disable();
        dragPanDisabledByUs = true;
      } catch {
        /* noop */
      }

      window.addEventListener('mousemove', handleWindowMouseMove, true);
      window.addEventListener('mouseup', handleWindowMouseUp, true);
      window.addEventListener('keydown', handleKeyDown, true);
    };

    container.addEventListener('mousedown', handleMouseDown, true);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mousemove', handleWindowMouseMove, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      removeClickSuppressor();
      restoreElement();
      target = null;
      if (dragging) {
        dragging = false;
        onDraggingChangeRef.current?.(false);
      }
      restoreDragPan();
    };
  }, [armed, map]);
}
