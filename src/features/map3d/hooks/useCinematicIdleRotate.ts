import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { isFreeCamActive } from '@/features/freeCam';
import { getCameraOwner } from '../lib/cameraOwnership';

export interface UseCinematicIdleRotateOptions {
  /**
   * Délai d'inactivité avant de lancer la rotation, en millisecondes.
   * 30 000 ms (30 secondes) par défaut.
   */
  idleDelayMs?: number;

  /**
   * Vitesse de rotation en degrés par seconde.
   * 2,5 °/s par défaut (un tour complet de 360° en 144 secondes).
   */
  speedDegPerSec?: number;

  /**
   * Indique si la rotation cinématique d'inactivité est active.
   * true par défaut.
   */
  enabled?: boolean;
}

/**
 * Hook qui fait tourner la caméra de façon fluide et cinématique sur 360°
 * autour du terrain quand l'utilisateur reste inactif plus de 30 secondes.
 *
 * S'annule instantanément et sans à-coup à la moindre interaction de
 * l'utilisateur (mouvement de souris, clic, toucher, touche, molette, glisser, etc.).
 */
export function useCinematicIdleRotate(
  map: MapboxMap | null,
  isLoaded: boolean,
  options: UseCinematicIdleRotateOptions = {},
): void {
  const {
    idleDelayMs = 30000,
    speedDegPerSec = 2.5,
    enabled = true,
  } = options;

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const isRotatingRef = useRef<boolean>(false);
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!map || !isLoaded || !enabled) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      isRotatingRef.current = false;
      return;
    }

    const stopRotation = () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      isRotatingRef.current = false;
    };

    const rotateStep = (time: number) => {
      if (!isRotatingRef.current) return;
      if (!map || typeof map.getBearing !== 'function' || getCameraOwner() != null) {
        stopRotation();
        return;
      }

      if (lastTimeRef.current > 0) {
        const deltaSec = Math.min((time - lastTimeRef.current) / 1000, 0.1);
        try {
          const currentBearing = map.getBearing();
          const nextBearing = (currentBearing + speedDegPerSec * deltaSec) % 360;
          map.setBearing(nextBearing);
        } catch {
          stopRotation();
          return;
        }
      }

      lastTimeRef.current = time;
      animFrameRef.current = requestAnimationFrame(rotateStep);
    };

    const startRotation = () => {
      if (isRotatingRef.current) return;
      if (document.hidden) return;
      if (isFreeCamActive() || getCameraOwner() != null) return;
      if (!map || typeof map.getBearing !== 'function') return;

      isRotatingRef.current = true;
      lastTimeRef.current = performance.now();
      animFrameRef.current = requestAnimationFrame(rotateStep);
    };

    const resetIdleTimer = () => {
      if (isRotatingRef.current) {
        stopRotation();
      }

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }

      idleTimerRef.current = setTimeout(() => {
        startRotation();
      }, idleDelayMs);
    };

    // Arme le minuteur d'inactivité initial
    resetIdleTimer();

    // User activity event listeners (window / document)
    const windowEvents = [
      'mousemove',
      'mousedown',
      'mouseup',
      'wheel',
      'keydown',
      'touchstart',
      'touchend',
      'touchmove',
      'pointerdown',
      'pointermove',
    ] as const;

    // Gestionnaire d'activité limité en fréquence pour les événements rapides comme pointermove
    let lastThrottledMs = 0;
    const handleThrottledActivity = () => {
      const now = Date.now();
      if (isRotatingRef.current || now - lastThrottledMs > 300) {
        lastThrottledMs = now;
        resetIdleTimer();
      }
    };

    const handleImmediateActivity = () => {
      resetIdleTimer();
    };

    windowEvents.forEach((evt) => {
      if (evt === 'mousemove' || evt === 'pointermove' || evt === 'touchmove') {
        window.addEventListener(evt, handleThrottledActivity, { passive: true });
      } else {
        window.addEventListener(evt, handleImmediateActivity, { passive: true });
      }
    });

    // Mapbox map interaction events
    const mapEvents = [
      'movestart',
      'zoomstart',
      'rotatestart',
      'pitchstart',
      'dragstart',
      'mousedown',
      'touchstart',
    ] as const;

    mapEvents.forEach((evt) => {
      try {
        map.on(evt, handleImmediateActivity);
      } catch { /* ignore */ }
    });

    // Pause / resume on tab visibility change
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopRotation();
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      } else {
        resetIdleTimer();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopRotation();
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      windowEvents.forEach((evt) => {
        window.removeEventListener(evt, handleThrottledActivity);
        window.removeEventListener(evt, handleImmediateActivity);
      });
      mapEvents.forEach((evt) => {
        try {
          map.off(evt, handleImmediateActivity);
        } catch { /* ignore */ }
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [map, isLoaded, enabled, idleDelayMs, speedDegPerSec]);
}
