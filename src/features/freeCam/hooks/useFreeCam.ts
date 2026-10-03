import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { FreeCamPose } from '../types';
import { FREECAM_ESCAPE_AFTER_UNLOCK_GRACE_MS, FREECAM_MIN_ZOOM } from '../lib/config';
import { createInputState, resetInputState } from '../lib/inputState';
import { raiseToFreeCamZoom, readPoseFromMap } from '../lib/cameraBridge';
import { isFreeCamEvent } from '../lib/eventData';
import { suspendMapInteractions } from '@/features/map3d/lib/mapInteractions';
import { isPointerLockedOn, lockPointer, unlockPointer } from '../lib/pointerLock';
import { registerFreeCamExitHandler, setFreeCamActive } from '../lib/freeCamRuntime';
import { useFreeCamKeyboard } from './useFreeCamKeyboard';
import { usePointerLook } from './usePointerLook';
import { useFreeCamLoop } from './useFreeCamLoop';
import { useFreeCamWheelSpeed } from './useFreeCamWheelSpeed';


/**
 * Caméra libre style jeu vidéo, sans UI.
 * F : activer / quitter · ZQSD / WASD / flèches : se déplacer · Maj : monter ·
 * Ctrl (ou Fn si le navigateur l'émet) : descendre · souris : regarder ·
 * molette : vitesse · Échap : libérer la souris, puis quitter.
 */
export function useFreeCam(map: MapboxMap | null): void {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const [input] = useState(createInputState);
  const poseRef = useRef<FreeCamPose | null>(null);
  const speedMultiplierRef = useRef(1);
  const lastUnlockAtRef = useRef(0);
  const restoreInteractionsRef = useRef<(() => void) | null>(null);

  const disable = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    resetInputState(input);
    poseRef.current = null;
    if (map) unlockPointer(map.getCanvas());
    restoreInteractionsRef.current?.();
    restoreInteractionsRef.current = null;
    setActive(false);
    setFreeCamActive(false);
  }, [input, map]);

  const enable = useCallback(() => {
    if (!map || activeRef.current) return;
    map.stop();
    if (map.getZoom() < FREECAM_MIN_ZOOM) {
      // Vue globe : on remonte au zoom plancher, la pose arrive après le rendu.
      poseRef.current = null;
      raiseToFreeCamZoom(map, (pose) => {
        if (activeRef.current) poseRef.current = pose;
      });
    } else {
      const pose = readPoseFromMap(map);
      if (!pose) return;
      poseRef.current = pose;
    }

    resetInputState(input);
    restoreInteractionsRef.current = suspendMapInteractions(map);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // Appel synchrone depuis le keydown : le geste utilisateur autorise le pointer lock.
    lockPointer(map.getCanvas());

    activeRef.current = true;
    setActive(true);
    setFreeCamActive(true);
  }, [input, map]);

  const toggle = useCallback(() => {
    if (activeRef.current) disable();
    else enable();
  }, [disable, enable]);

  const handleEscape = useCallback(() => {
    if (!map) return;
    const canvas = map.getCanvas();
    if (isPointerLockedOn(canvas)) {
      unlockPointer(canvas);
      return;
    }
    // Le navigateur a déjà consommé cet Échap pour libérer la souris.
    if (performance.now() - lastUnlockAtRef.current < FREECAM_ESCAPE_AFTER_UNLOCK_GRACE_MS) return;
    disable();
  }, [disable, map]);

  useFreeCamKeyboard({ enabled: Boolean(map), activeRef, input, onToggle: toggle, onEscape: handleEscape });
  usePointerLook({ map, active, input, lastUnlockAtRef });
  useFreeCamWheelSpeed({ map, active, speedMultiplierRef });
  useFreeCamLoop({ map, active, input, poseRef, speedMultiplierRef });

  // Si autre chose bouge la caméra pendant le vol (recherche de lieu, style
  // reload…), on repart de la vraie position au lieu de la ramener en arrière.
  useEffect(() => {
    if (!map || !active) return;
    const handleMove = (event: object) => {
      if (isFreeCamEvent(event)) return;
      const pose = readPoseFromMap(map);
      if (pose) poseRef.current = pose;
    };
    map.on('move', handleMove);
    return () => {
      map.off('move', handleMove);
    };
  }, [map, active]);

  useEffect(() => {
    registerFreeCamExitHandler(disable);
    return () => {
      registerFreeCamExitHandler(null);
      disable();
    };
  }, [disable]);
}
