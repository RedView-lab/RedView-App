import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { FreeCamMode, FreeCamTelemetry, UseFreeCamOptions, UseFreeCamReturn } from '../types';
import { DEFAULT_FREECAM_CONFIG, SPEED_MULTIPLIER_STEPS } from '../lib/freeCamConfig';
import {
  createEmptyKeys,
  isMouseToggleKey,
  isPlanModeToggleKey,
  isToggleShortcut,
  updateKeysFromEvent,
} from '../lib/freeCamControls';
import {
  calculateMovementDelta,
  clampCoordinates,
  clampPitch,
  getZoomSpeedScale,
  normalizeBearing,
  sampleTerrainAltitudeM,
} from '../lib/freeCamMath';

export function useFreeCam(
  map: MapboxMap | null,
  options: UseFreeCamOptions = {},
): UseFreeCamReturn {
  const { config: userConfig, onActiveChange, onModeChange } = options;
  const config = { ...DEFAULT_FREECAM_CONFIG, ...userConfig };

  const [isActive, setIsActive] = useState(false);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [mode, setModeState] = useState<FreeCamMode>('3d');
  const [speedMultiplier, setSpeedMultiplierState] = useState(1.0);

  const [telemetry, setTelemetry] = useState<FreeCamTelemetry>({
    isActive: false,
    isPointerLocked: false,
    mode: '3d',
    zoom: 5,
    pitch: 0,
    bearing: 0,
    speedMultiplier: 1.0,
    altitudeM: null,
    coordinates: [0, 0],
  });

  // State refs
  const isActiveRef = useRef(false);
  const modeRef = useRef<FreeCamMode>('3d');
  const isPointerLockedRef = useRef(false);
  const speedMultiplierRef = useRef(1.0);
  const activeKeysRef = useRef(createEmptyKeys());
  const needsRenderRef = useRef(false);

  // Camera coordinates (synchronized strictly on activation — no forced jumps)
  const currentCenterRef = useRef<[number, number]>([0, 0]);
  const currentZoomRef = useRef(5);
  const currentPitchRef = useRef(0);
  const currentBearingRef = useRef(0);

  // Stored original Mapbox handlers to restore on exit
  const originalHandlersRef = useRef<{
    dragPan: boolean;
    scrollZoom: boolean;
    boxZoom: boolean;
    dragRotate: boolean;
    keyboard: boolean;
    doubleClickZoom: boolean;
    touchZoomRotate: boolean;
    touchPitch: boolean;
  } | null>(null);

  const animFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastTelemetrySyncRef = useRef<number>(0);

  // Sync refs with React state
  useEffect(() => {
    isActiveRef.current = isActive;
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  useEffect(() => {
    modeRef.current = mode;
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  useEffect(() => {
    speedMultiplierRef.current = speedMultiplier;
  }, [speedMultiplier]);

  useEffect(() => {
    isPointerLockedRef.current = isPointerLocked;
  }, [isPointerLocked]);

  // Request pointer lock
  const requestPointerLock = useCallback(() => {
    if (!map) return;
    try {
      const canvas = map.getCanvas();
      if (canvas && document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.();
      }
    } catch {
      /* ignore */
    }
  }, [map]);

  // Exit pointer lock
  const exitPointerLock = useCallback(() => {
    try {
      if (document.pointerLockElement) {
        document.exitPointerLock?.();
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Enable FreeCam
  const enableFreeCam = useCallback(() => {
    if (!map || isActiveRef.current) return;

    // Snapshot exact current position — ZERO forced camera jump
    const center = map.getCenter();
    const zoom = map.getZoom();
    const pitch = map.getPitch();
    const bearing = map.getBearing();

    currentCenterRef.current = [center.lng, center.lat];
    currentZoomRef.current = zoom;
    currentPitchRef.current = pitch;
    currentBearingRef.current = bearing;
    activeKeysRef.current = createEmptyKeys();
    needsRenderRef.current = false;

    // Save Mapbox interactive handlers
    originalHandlersRef.current = {
      dragPan: map.dragPan.isEnabled(),
      scrollZoom: map.scrollZoom.isEnabled(),
      boxZoom: map.boxZoom.isEnabled(),
      dragRotate: map.dragRotate.isEnabled(),
      keyboard: map.keyboard.isEnabled(),
      doubleClickZoom: map.doubleClickZoom.isEnabled(),
      touchZoomRotate: map.touchZoomRotate.isEnabled(),
      touchPitch: map.touchPitch.isEnabled(),
    };

    // Disable Mapbox standard handlers so they don't fight flight controls
    map.dragPan.disable();
    map.scrollZoom.disable();
    map.boxZoom.disable();
    map.dragRotate.disable();
    map.keyboard.disable();
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disable();
    map.touchPitch.disable();

    setIsActive(true);
    isActiveRef.current = true;

    // Request pointer lock for mouse look
    requestPointerLock();
  }, [map, requestPointerLock]);

  // Disable FreeCam
  const disableFreeCam = useCallback(() => {
    if (!map || !isActiveRef.current) return;

    exitPointerLock();
    activeKeysRef.current = createEmptyKeys();
    needsRenderRef.current = false;

    // Restore Mapbox interactive handlers
    if (originalHandlersRef.current) {
      if (originalHandlersRef.current.dragPan) map.dragPan.enable();
      if (originalHandlersRef.current.scrollZoom) map.scrollZoom.enable();
      if (originalHandlersRef.current.boxZoom) map.boxZoom.enable();
      if (originalHandlersRef.current.dragRotate) map.dragRotate.enable();
      if (originalHandlersRef.current.keyboard) map.keyboard.enable();
      if (originalHandlersRef.current.doubleClickZoom) map.doubleClickZoom.enable();
      if (originalHandlersRef.current.touchZoomRotate) map.touchZoomRotate.enable();
      if (originalHandlersRef.current.touchPitch) map.touchPitch.enable();
      originalHandlersRef.current = null;
    }

    map.triggerRepaint();

    setIsActive(false);
    isActiveRef.current = false;
  }, [exitPointerLock, map]);

  const toggleFreeCam = useCallback(() => {
    if (isActiveRef.current) {
      disableFreeCam();
    } else {
      enableFreeCam();
    }
  }, [disableFreeCam, enableFreeCam]);

  const setMode = useCallback((newMode: FreeCamMode) => {
    setModeState(newMode);
    modeRef.current = newMode;
    if (newMode === 'plan') {
      currentPitchRef.current = 0;
      needsRenderRef.current = true;
    }
  }, []);

  const toggleMode = useCallback(() => {
    setMode(modeRef.current === '3d' ? 'plan' : '3d');
  }, [setMode]);

  const setSpeedMultiplier = useCallback((val: number | ((prev: number) => number)) => {
    setSpeedMultiplierState((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      const clamped = Math.max(0.25, Math.min(16.0, next));
      speedMultiplierRef.current = clamped;
      return clamped;
    });
  }, []);

  const increaseSpeed = useCallback(() => {
    setSpeedMultiplier((prev) => {
      const idx = SPEED_MULTIPLIER_STEPS.findIndex((s) => s > prev + 0.05);
      return idx !== -1 ? SPEED_MULTIPLIER_STEPS[idx] : Math.min(16, prev * 1.5);
    });
  }, [setSpeedMultiplier]);

  const decreaseSpeed = useCallback(() => {
    setSpeedMultiplier((prev) => {
      const reversed = [...SPEED_MULTIPLIER_STEPS].reverse();
      const idx = reversed.findIndex((s) => s < prev - 0.05);
      return idx !== -1 ? reversed[idx] : Math.max(0.25, prev / 1.5);
    });
  }, [setSpeedMultiplier]);

  // Global keyboard shortcuts (Alt+Space to toggle FreeCam, E to toggle pointer lock, P for Plan mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle FreeCam mode via Alt + Space / Option + Espace
      if (isToggleShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleFreeCam();
        return;
      }

      if (!isActiveRef.current) return;

      // Escape: release mouse lock or exit FreeCam
      if (e.code === 'Escape' || e.key === 'Escape') {
        e.preventDefault();
        if (isPointerLockedRef.current) {
          exitPointerLock();
        } else {
          disableFreeCam();
        }
        return;
      }

      // E key: release / regain mouse pointer lock ("retrouver la souris")
      if (isMouseToggleKey(e)) {
        e.preventDefault();
        if (isPointerLockedRef.current) {
          exitPointerLock();
        } else {
          requestPointerLock();
        }
        return;
      }

      // P key: toggle 3D / Plan view
      if (isPlanModeToggleKey(e)) {
        e.preventDefault();
        toggleMode();
        return;
      }

      // Movement keys (Z, Q, S, D, Maj, Fn/Ctrl/C)
      const handled = updateKeysFromEvent(activeKeysRef.current, e, true);
      if (handled) {
        e.preventDefault();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      const handled = updateKeysFromEvent(activeKeysRef.current, e, false);
      if (handled) {
        e.preventDefault();
      }
    };

    const handleBlur = () => {
      activeKeysRef.current = createEmptyKeys();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleBlur);
    };
  }, [disableFreeCam, exitPointerLock, requestPointerLock, toggleFreeCam, toggleMode]);

  // Mouse wheel speed adjustment while FreeCam is active
  useEffect(() => {
    if (!isActive) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        increaseSpeed();
      } else if (e.deltaY > 0) {
        decreaseSpeed();
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, [decreaseSpeed, increaseSpeed, isActive]);

  // Mouse Look (Minecraft 1:1 direct orientation — no lag, no phantom rotation)
  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();

    const handlePointerLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      setIsPointerLocked(locked);
      isPointerLockedRef.current = locked;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isActiveRef.current || !isPointerLockedRef.current) return;

      const dx = e.movementX ?? 0;
      const dy = e.movementY ?? 0;
      if (dx === 0 && dy === 0) return;

      const sens = config.mouseSensitivity;

      if (modeRef.current === 'plan') {
        currentBearingRef.current = normalizeBearing(currentBearingRef.current + dx * sens);
        needsRenderRef.current = true;
        return;
      }

      // Minecraft creative style:
      // Moving mouse right -> turns right (bearing increases)
      // Moving mouse up (negative dy) -> looks up towards horizon/sky (pitch increases)
      // Moving mouse down (positive dy) -> looks down towards ground (pitch decreases)
      currentBearingRef.current = normalizeBearing(currentBearingRef.current + dx * sens);
      currentPitchRef.current = clampPitch(
        currentPitchRef.current - dy * sens,
        config.minPitch,
        config.maxPitch,
      );
      needsRenderRef.current = true;
    };

    const handleCanvasClick = () => {
      if (isActiveRef.current && !isPointerLockedRef.current) {
        requestPointerLock();
      }
    };

    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('click', handleCanvasClick);

    return () => {
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('click', handleCanvasClick);
    };
  }, [config.maxPitch, config.minPitch, config.mouseSensitivity, map, requestPointerLock]);

  // Minecraft Creative Mode Flying Loop (Zero drift when keys are released)
  useEffect(() => {
    if (!map || !isActive) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      return;
    }

    const frameStep = (time: number) => {
      if (!isActiveRef.current) return;

      if (lastTimeRef.current === 0) {
        lastTimeRef.current = time;
      }

      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = time;

      const keys = activeKeysRef.current;
      const mult = speedMultiplierRef.current;

      let inputX = 0; // -1 = left, +1 = right
      let inputY = 0; // -1 = backward, +1 = forward
      let inputZoom = 0; // -1 = fly up (zoom out), +1 = fly down (zoom in)

      if (keys.forward) inputY += 1;
      if (keys.backward) inputY -= 1;
      if (keys.right) inputX += 1;
      if (keys.left) inputX -= 1;

      // Maj = prendre de l'altitude (zoom out)
      if (keys.ascend) inputZoom -= 1;
      // Fn / Control / C = perdre de l'altitude (zoom in)
      if (keys.descend) inputZoom += 1;

      let hasMovement = false;

      // 1. Horizontal Creative flight translation
      if (inputX !== 0 || inputY !== 0) {
        hasMovement = true;
        const zoomSpeedScale = getZoomSpeedScale(currentZoomRef.current);
        const effectiveSpeed = config.baseSpeedMps * zoomSpeedScale * mult;

        const { deltaLng, deltaLat } = calculateMovementDelta(
          currentBearingRef.current,
          inputX,
          inputY,
          effectiveSpeed,
          dt,
          currentCenterRef.current[1],
        );

        const [nextLng, nextLat] = clampCoordinates(
          currentCenterRef.current[0] + deltaLng,
          currentCenterRef.current[1] + deltaLat,
        );
        currentCenterRef.current = [nextLng, nextLat];
      }

      // 2. Vertical Creative flight altitude (zoom)
      if (inputZoom !== 0) {
        hasMovement = true;
        const zoomDelta = inputZoom * config.zoomSpeed * mult * dt;
        const minZ = map.getMinZoom?.() ?? 1;
        const maxZ = map.getMaxZoom?.() ?? 20;
        currentZoomRef.current = Math.max(minZ, Math.min(maxZ, currentZoomRef.current + zoomDelta));
      }

      // 3. ZERO DRIFT CHECK:
      // If no keys are held and mouse hasn't moved: DO NOT TOUCH THE MAP!
      if (!hasMovement && !needsRenderRef.current) {
        animFrameRef.current = requestAnimationFrame(frameStep);
        return;
      }

      needsRenderRef.current = false;

      // 4. Update Mapbox camera
      try {
        map.jumpTo({
          center: currentCenterRef.current,
          zoom: currentZoomRef.current,
          pitch: currentPitchRef.current,
          bearing: currentBearingRef.current,
        });
      } catch {
        /* map may be disposing */
      }

      // 5. Sync telemetry for any external consumer
      if (time - lastTelemetrySyncRef.current >= 150) {
        lastTelemetrySyncRef.current = time;
        const altitude = sampleTerrainAltitudeM(
          map,
          currentCenterRef.current[0],
          currentCenterRef.current[1],
        );
        setTelemetry({
          isActive: true,
          isPointerLocked: isPointerLockedRef.current,
          mode: modeRef.current,
          zoom: Number(currentZoomRef.current.toFixed(2)),
          pitch: Math.round(currentPitchRef.current),
          bearing: Math.round(currentBearingRef.current),
          speedMultiplier: mult,
          altitudeM: altitude,
          coordinates: [
            Number(currentCenterRef.current[0].toFixed(4)),
            Number(currentCenterRef.current[1].toFixed(4)),
          ],
        });
      }

      animFrameRef.current = requestAnimationFrame(frameStep);
    };

    lastTimeRef.current = performance.now();
    animFrameRef.current = requestAnimationFrame(frameStep);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [config.baseSpeedMps, config.zoomSpeed, isActive, map]);

  return {
    isActive,
    isPointerLocked,
    mode,
    speedMultiplier,
    telemetry,
    toggleFreeCam,
    enableFreeCam,
    disableFreeCam,
    toggleMode,
    setMode,
    requestPointerLock,
    exitPointerLock,
    setSpeedMultiplier,
    increaseSpeed,
    decreaseSpeed,
  };
}
