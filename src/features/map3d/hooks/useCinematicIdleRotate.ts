import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

export interface UseCinematicIdleRotateOptions {
  /**
   * Inactivity delay before starting rotation, in milliseconds.
   * Defaults to 30,000 ms (30 seconds).
   */
  idleDelayMs?: number;

  /**
   * Rotation speed in degrees per second.
   * Defaults to 2.5 deg/sec (full 360° turn in 144 seconds).
   */
  speedDegPerSec?: number;

  /**
   * Whether the cinematic idle rotation is enabled.
   * Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Hook providing a smooth, cinematic 360° terrain camera rotation
 * when the user remains inactive for +30 seconds.
 *
 * Instantly and seamlessly cancels as soon as any user interaction occurs
 * (mouse move, click, touch, key press, wheel, drag, etc.).
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
  const lastInteractionRef = useRef<number>(Date.now());

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
      if (!map || typeof map.getBearing !== 'function') {
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
      if (!map || typeof map.getBearing !== 'function') return;

      isRotatingRef.current = true;
      lastTimeRef.current = performance.now();
      animFrameRef.current = requestAnimationFrame(rotateStep);
    };

    const resetIdleTimer = () => {
      lastInteractionRef.current = Date.now();

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

    // Arm the initial idle timer
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

    // Throttled activity handler for high-frequency events like pointermove
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
