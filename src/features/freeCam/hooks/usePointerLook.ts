import { useEffect, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { FreeCamInputState } from '../lib/inputState';
import { isPointerLockedOn, lockPointer } from '../lib/pointerLock';

/** Chrome/Windows émet parfois un `movementX` aberrant (saut de plusieurs centaines de px) : on l'ignore. */
const MAX_MOUSE_DELTA_PX = 250;

interface UsePointerLookArgs {
  map: MapboxMap | null;
  active: boolean;
  input: FreeCamInputState;
  /** Horodatage (`performance.now()`) de la dernière perte du pointer lock. */
  lastUnlockAtRef: RefObject<number>;
}

/** Regard souris en pointer lock ; clic sur la carte = recapture ; clics carte neutralisés. */
export function usePointerLook({ map, active, input, lastUnlockAtRef }: UsePointerLookArgs): void {
  useEffect(() => {
    if (!map || !active) return;
    const canvas = map.getCanvas();

    const handleMouseMove = (event: MouseEvent) => {
      if (!isPointerLockedOn(canvas)) return;
      const dx = event.movementX;
      const dy = event.movementY;
      if (Math.abs(dx) > MAX_MOUSE_DELTA_PX || Math.abs(dy) > MAX_MOUSE_DELTA_PX) return;
      input.lookDx += dx;
      input.lookDy += dy;
    };

    const handlePointerLockChange = () => {
      if (!isPointerLockedOn(canvas)) {
        lastUnlockAtRef.current = performance.now();
      }
    };

    // En vol, les clics ne doivent atteindre ni Mapbox (clic tracer, POI…) ni
    // les listeners posés directement sur le canvas (menu contextuel).
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const handleCanvasMouseDown = (event: MouseEvent) => {
      swallow(event);
      lockPointer(canvas);
    };

    const swallowedEvents = ['mouseup', 'click', 'dblclick', 'contextmenu'] as const;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    canvas.addEventListener('mousedown', handleCanvasMouseDown, true);
    for (const type of swallowedEvents) canvas.addEventListener(type, swallow, true);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      canvas.removeEventListener('mousedown', handleCanvasMouseDown, true);
      for (const type of swallowedEvents) canvas.removeEventListener(type, swallow, true);
    };
  }, [map, active, input, lastUnlockAtRef]);
}
