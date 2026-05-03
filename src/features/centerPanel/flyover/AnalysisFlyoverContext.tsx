import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { AxisDomain, AxisMode } from '../components/chart';
import { locateRoutePointAtX } from '../components/chart';
import {
  buildCinematicCameraTarget,
  cinematicBearingAtDistance,
  buildRoutePlaybackGeometry,
  buildRouteTrailCoordinates,
  clampDistanceM,
  distanceBetweenRoutePlaybackPointsM,
  elapsedSecondsAtDistance,
  formatDistanceLabel,
  formatPlaybackClock,
  interpolateRoutePointAtDistance,
  xValueFromDistance,
} from './playback';
import {
  usePredictionStoreOptional,
  useProjectStoreOptional,
} from '@/features/itineraryPanel';
import {
  buildItineraryVisualNodes,
  getItineraryStartDistanceKm,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import {
  clearAnalysisFlyoverProgress,
  clearAnalysisHoverPoint,
  setRouteLayerVisibility,
  setAnalysisFlyoverProgress,
  setAnalysisHoverPoint,
} from '@/features/itineraryPanel/lib/route-layer';
import { selectInteractiveItineraryForChartX } from '../components/analysis/shared';

const SPEED_STEPS = [0.5, 0.75, 1, 1.5, 2, 3] as const;
const DEFAULT_SPEED_INDEX = 2;
const FLYOVER_REFERENCE_DISTANCE_KM = 80;
const FLYOVER_REFERENCE_DURATION_MS = 40_000;
const FLYOVER_MIN_DURATION_MS = 12_000;
const FLYOVER_MAX_DURATION_MS = 180_000;
const FLYOVER_CAMERA_ZOOM = 15.6;
const FLYOVER_CAMERA_PITCH = 70;
const FLYOVER_CENTER_SMOOTHING = 0.12;
const FLYOVER_BEARING_SMOOTHING = 0.075;
const FLYOVER_ZOOM_SMOOTHING = 0.14;
const FLYOVER_PITCH_SMOOTHING = 0.09;
const FLYOVER_RELIEF_PITCH_ATTACK_SMOOTHING = 0.032;
const FLYOVER_RELIEF_PITCH_RELEASE_SMOOTHING = 0.11;
const FLYOVER_RELIEF_PITCH_DEADBAND_DEG = 0.08;
const FLYOVER_RELIEF_PITCH_MAX_STEP_DEG = 0.14;
const FLYOVER_MICRO_TURN_THRESHOLD_DEG = 4.5;
const FLYOVER_MIN_BEARING_PROGRESS_M = 18;
const FLYOVER_TURN_LOOKAHEAD_THRESHOLD_DEG = 10;
const FLYOVER_RELIEF_ENGAGE_THRESHOLD_M = 50;
const FLYOVER_RELIEF_RELEASE_THRESHOLD_M = 32;
const HOVER_X_VALUE_EPSILON = 1e-4;
const HOVER_MARKER_POSITION_EPSILON = 1e-6;

interface AnalysisFlyoverContextValue {
  canPlay: boolean;
  isPlaying: boolean;
  playbackActive: boolean;
  controlledHoverXValue: number | null;
  setManualHoverXValue: (xValue: number | null) => void;
  togglePlayback: () => void;
  slowDown: () => void;
  speedUp: () => void;
  resetPlayback: () => void;
  canSlowDown: boolean;
  canSpeedUp: boolean;
  distanceLabel: string;
  timeLabel: string;
  speedLabel: string;
}

const AnalysisFlyoverContext = createContext<AnalysisFlyoverContextValue | null>(null);

interface AnalysisFlyoverProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

export function AnalysisFlyoverProvider({
  children,
  map,
}: AnalysisFlyoverProviderProps) {
  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const [playbackDistanceM, setPlaybackDistanceM] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX);
  const [playbackSessionId, setPlaybackSessionId] = useState(0);
  const manualHoverXValueRef = useRef<number | null>(null);
  const playbackDistanceRef = useRef<number | null>(null);
  const lastCameraPointRef = useRef<ReturnType<typeof interpolateRoutePointAtDistance> | null>(null);
  const lastStableBearingRef = useRef<number | null>(null);
  const primedPlaybackSessionRef = useRef<number | null>(null);
  const reliefPitchEnabledRef = useRef(false);
  const reliefPitchOffsetRef = useRef(0);
  const hoverSyncFrameRef = useRef<number | null>(null);
  const lastHoverMarkerRef = useRef<{ lon: number; lat: number; color: string } | null>(null);

  const interactiveItinerary = useMemo(() => {
    if (!projectStore) return null;
    const itineraries = projectStore.project.itineraries;
    const active =
      itineraries.find((itinerary) => itinerary.id === projectStore.project.activeItineraryId) ??
      null;
    if (active && active.analysisVisible !== false && (active.gpxRoute?.points.length ?? 0) > 0) {
      return active;
    }
    return (
      itineraries.find(
        (itinerary) =>
          itinerary.analysisVisible !== false && (itinerary.gpxRoute?.points.length ?? 0) > 0,
      ) ?? null
    );
  }, [projectStore]);

  const xMode = ((projectStore?.project.analysis?.xMode as AxisMode | undefined) ??
    'distance') as AxisMode;
  const visibleChartNodes = useMemo(() => {
    if (!projectStore) return [];
    return buildItineraryVisualNodes(projectStore.project.itineraries)
      .filter(
        ({ itinerary }) =>
          itinerary.analysisVisible !== false && (itinerary.gpxRoute?.points.length ?? 0) > 0,
      )
      .map(({ itinerary, startDistanceKm }) => ({ itinerary, startDistanceKm }));
  }, [projectStore]);
  const routePoints = interactiveItinerary?.gpxRoute?.points ?? null;
  const prediction =
    interactiveItinerary != null
      ? predictionStore?.predictions[interactiveItinerary.id] ?? interactiveItinerary.prediction ?? null
      : null;
  const routeGeometry = useMemo(() => buildRoutePlaybackGeometry(routePoints), [routePoints]);
  const totalDistanceM = useMemo(() => {
    const predictedDistanceM = prediction?.total_distance_m;
    if (Number.isFinite(predictedDistanceM) && (predictedDistanceM as number) > 0) {
      return predictedDistanceM as number;
    }
    return routeGeometry?.totalDistanceM ?? 0;
  }, [prediction, routeGeometry]);
  const startTime = interactiveItinerary?.rhythm.startTime ?? null;

  const routeXDomain = useMemo<AxisDomain | null>(() => {
    if (!(totalDistanceM > 0)) return null;

    const maxXValue = xValueFromDistance(totalDistanceM, {
      prediction,
      totalDistanceM,
      xMode,
      startTime,
    });
    if (!Number.isFinite(maxXValue)) return null;

    if (xMode === 'distance') {
      return { min: 0, max: maxXValue as number };
    }
    if (xMode === 'heure') {
      const minXValue = xValueFromDistance(0, {
        prediction,
        totalDistanceM,
        xMode,
        startTime,
      });
      if (!Number.isFinite(minXValue)) return null;
      return { min: minXValue as number, max: maxXValue as number };
    }
    return { min: 0, max: maxXValue as number };
  }, [prediction, startTime, totalDistanceM, xMode]);

  const itineraryId = interactiveItinerary?.id ?? null;
  useEffect(() => {
    setIsPlaying(false);
    setPlaybackDistanceM(null);
    manualHoverXValueRef.current = null;
    setSpeedIndex(DEFAULT_SPEED_INDEX);
    lastCameraPointRef.current = null;
    lastStableBearingRef.current = null;
    primedPlaybackSessionRef.current = null;
    reliefPitchEnabledRef.current = false;
    reliefPitchOffsetRef.current = 0;
  }, [itineraryId]);

  useEffect(() => {
    playbackDistanceRef.current = playbackDistanceM;
  }, [playbackDistanceM]);

  const speedMultiplier = SPEED_STEPS[speedIndex] ?? 1;
  const playbackActive = playbackDistanceM != null && totalDistanceM > 0;
  const canPlay = Boolean(
    routePoints &&
      routePoints.length >= 2 &&
      totalDistanceM > 1 &&
      routeXDomain &&
      Number.isFinite(
        xValueFromDistance(totalDistanceM, {
          prediction,
          totalDistanceM,
          xMode,
          startTime,
        }),
      ),
  );

  const controlledHoverXValue = useMemo(() => {
    if (playbackDistanceM == null || totalDistanceM <= 0) return null;
    const localXValue = xValueFromDistance(playbackDistanceM, {
      prediction,
      totalDistanceM,
      xMode,
      startTime,
    });
    if (!Number.isFinite(localXValue)) return null;
    if (xMode !== 'distance') return localXValue;
    return localXValue + getItineraryStartDistanceKm(interactiveItinerary ?? undefined as never);
  }, [interactiveItinerary, playbackDistanceM, prediction, startTime, totalDistanceM, xMode]);

  const clearHoverMarker = useCallback((targetMap: MapboxMap | null) => {
    if (!targetMap) return;
    if (lastHoverMarkerRef.current == null) return;
    lastHoverMarkerRef.current = null;
    clearAnalysisHoverPoint(targetMap);
  }, []);

  const syncHoverMarker = useCallback(() => {
    if (!map) return;
    if (!interactiveItinerary) {
      clearHoverMarker(map);
      return;
    }

    const manualHoverXValue = manualHoverXValueRef.current;
    const targetItinerary = Number.isFinite(manualHoverXValue)
      ? selectInteractiveItineraryForChartX(
          visibleChartNodes,
          interactiveItinerary.id,
          xMode,
          manualHoverXValue as number,
        )
      : interactiveItinerary;
    if (!targetItinerary) {
      clearHoverMarker(map);
      return;
    }

    const targetPrediction =
      predictionStore?.predictions[targetItinerary.id] ?? targetItinerary.prediction ?? null;
    const targetRoutePoints = targetItinerary.gpxRoute?.points ?? null;
    const targetStartTime = targetItinerary.rhythm.startTime ?? null;
    const localHoverXValue =
      xMode === 'distance' && Number.isFinite(manualHoverXValue)
        ? (manualHoverXValue as number) - getItineraryStartDistanceKm(targetItinerary)
        : manualHoverXValue;

    const nextRoutePoint = playbackDistanceM != null
      ? interpolateRoutePointAtDistance(routePoints, routeGeometry, playbackDistanceM)
      : Number.isFinite(localHoverXValue)
        ? locateRoutePointAtX(
            targetRoutePoints,
            targetPrediction,
            xMode,
            localHoverXValue as number,
            targetStartTime,
          )
        : null;

    if (!nextRoutePoint) {
      clearHoverMarker(map);
      return;
    }

    const nextMarker = {
      lon: nextRoutePoint.lon,
      lat: nextRoutePoint.lat,
      color: targetItinerary.color,
    };
    const previousMarker = lastHoverMarkerRef.current;
    if (
      previousMarker &&
      Math.abs(previousMarker.lon - nextMarker.lon) <= HOVER_MARKER_POSITION_EPSILON &&
      Math.abs(previousMarker.lat - nextMarker.lat) <= HOVER_MARKER_POSITION_EPSILON &&
      previousMarker.color === nextMarker.color
    ) {
      return;
    }

    lastHoverMarkerRef.current = nextMarker;
    setAnalysisHoverPoint(map, nextMarker);
  }, [
    clearHoverMarker,
    interactiveItinerary,
    map,
    playbackDistanceM,
    predictionStore,
    routeGeometry,
    routePoints,
    visibleChartNodes,
    startTime,
    xMode,
  ]);

  const scheduleHoverMarkerSync = useCallback(() => {
    if (hoverSyncFrameRef.current !== null) return;
    hoverSyncFrameRef.current = window.requestAnimationFrame(() => {
      hoverSyncFrameRef.current = null;
      syncHoverMarker();
    });
  }, [syncHoverMarker]);

  const setManualHoverXValue = useCallback((xValue: number | null) => {
    const previousValue = manualHoverXValueRef.current;
    if (previousValue == null || xValue == null) {
      if (previousValue === xValue) return;
    } else if (Math.abs(previousValue - xValue) <= HOVER_X_VALUE_EPSILON) {
      return;
    }
    manualHoverXValueRef.current = xValue;
    scheduleHoverMarkerSync();
  }, [scheduleHoverMarkerSync]);

  const playbackRoutePoint = useMemo(() => {
    if (playbackDistanceM == null) return null;
    return interpolateRoutePointAtDistance(routePoints, routeGeometry, playbackDistanceM);
  }, [playbackDistanceM, routeGeometry, routePoints]);

  const playbackBearing = useMemo(() => {
    if (playbackDistanceM == null) return null;
    return cinematicBearingAtDistance(routePoints, routeGeometry, playbackDistanceM);
  }, [playbackDistanceM, routeGeometry, routePoints]);

  const playbackCameraTarget = useMemo(() => {
    if (playbackDistanceM == null) return null;
    return buildCinematicCameraTarget(routePoints, routeGeometry, playbackDistanceM);
  }, [playbackDistanceM, routeGeometry, routePoints]);

  const playbackTrail = useMemo(() => {
    if (playbackDistanceM == null) return [];
    return buildRouteTrailCoordinates(routePoints, routeGeometry, playbackDistanceM);
  }, [playbackDistanceM, routeGeometry, routePoints]);

  const baseDurationMs = useMemo(() => {
    if (!(totalDistanceM > 0)) return FLYOVER_REFERENCE_DURATION_MS;
    const scaled =
      ((totalDistanceM / 1000) / FLYOVER_REFERENCE_DISTANCE_KM) * FLYOVER_REFERENCE_DURATION_MS;
    return Math.max(FLYOVER_MIN_DURATION_MS, Math.min(FLYOVER_MAX_DURATION_MS, scaled));
  }, [totalDistanceM]);

  useEffect(() => {
    if (!isPlaying || !canPlay || totalDistanceM <= 0) return;

    const startDistanceM = clampDistanceM(playbackDistanceRef.current ?? 0, totalDistanceM);
    const remainingDistanceM = totalDistanceM - startDistanceM;
    if (remainingDistanceM <= 0.25) {
      setPlaybackDistanceM(totalDistanceM);
      setIsPlaying(false);
      return;
    }

    const remainingDurationMs =
      (remainingDistanceM / totalDistanceM) * (baseDurationMs / speedMultiplier);
    let rafId = 0;
    let frameStartMs = 0;

    const step = (now: number) => {
      if (frameStartMs === 0) frameStartMs = now;
      const elapsedMs = now - frameStartMs;
      const progress = remainingDurationMs <= 0 ? 1 : Math.min(1, elapsedMs / remainingDurationMs);
      const nextDistanceM = startDistanceM + remainingDistanceM * progress;
      setPlaybackDistanceM(nextDistanceM);

      if (progress >= 1) {
        setPlaybackDistanceM(totalDistanceM);
        setIsPlaying(false);
        return;
      }

      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [baseDurationMs, canPlay, isPlaying, playbackSessionId, speedMultiplier, totalDistanceM]);

  useEffect(() => {
    syncHoverMarker();
  }, [syncHoverMarker]);

  useEffect(() => {
    if (!map) return;
    if (playbackTrail.length >= 2 && interactiveItinerary) {
      setAnalysisFlyoverProgress(map, playbackTrail, interactiveItinerary.color);
      return;
    }
    clearAnalysisFlyoverProgress(map);
  }, [interactiveItinerary, map, playbackTrail]);

  useEffect(() => {
    if (!map || !interactiveItinerary) return;
    setRouteLayerVisibility(map, interactiveItinerary.id, !playbackActive);
    return () => {
      setRouteLayerVisibility(map, interactiveItinerary.id, true);
    };
  }, [interactiveItinerary, map, playbackActive]);

  useEffect(() => {
    if (!map || !isPlaying || !playbackRoutePoint || !playbackCameraTarget) return;

    const previousCameraPoint = lastCameraPointRef.current;
    const movedDistanceM = distanceBetweenRoutePlaybackPointsM(previousCameraPoint, playbackCameraTarget.point);
    const currentBearing = map.getBearing();
    const previousStableBearing = lastStableBearingRef.current ?? currentBearing;
    const desiredBearing = playbackCameraTarget.bearing ?? playbackBearing ?? previousStableBearing;
    const bearingDelta = angularDeltaDegrees(previousStableBearing, desiredBearing);
    const stableBearing =
      movedDistanceM < FLYOVER_MIN_BEARING_PROGRESS_M && bearingDelta < FLYOVER_MICRO_TURN_THRESHOLD_DEG
        ? previousStableBearing
        : bearingDelta < FLYOVER_MICRO_TURN_THRESHOLD_DEG
          ? previousStableBearing
          : desiredBearing;

    const turnBoostDeg = Math.abs(playbackCameraTarget.turnDeltaDeg);
    const pitchTurnBoost = turnBoostDeg >= FLYOVER_TURN_LOOKAHEAD_THRESHOLD_DEG ? 1.2 : 0;
    const reliefStrengthM = Math.max(
      Math.abs(playbackCameraTarget.elevationDeltaM ?? 0),
      Math.abs(playbackCameraTarget.elevationRangeM ?? 0),
    );
    if (reliefPitchEnabledRef.current) {
      if (reliefStrengthM <= FLYOVER_RELIEF_RELEASE_THRESHOLD_M) {
        reliefPitchEnabledRef.current = false;
      }
    } else if (reliefStrengthM >= FLYOVER_RELIEF_ENGAGE_THRESHOLD_M) {
      reliefPitchEnabledRef.current = true;
    }
    const smoothedGradientPitch = reliefPitchEnabledRef.current
      ? clampPitchOffset(-(playbackCameraTarget.smoothedGradientPct ?? 0) * 0.11)
      : 0;
    const filteredReliefPitch = smoothReliefPitchOffset(
      reliefPitchOffsetRef.current,
      smoothedGradientPitch,
    );
    reliefPitchOffsetRef.current = filteredReliefPitch;
    const targetPitch = FLYOVER_CAMERA_PITCH + pitchTurnBoost + filteredReliefPitch;

    lastCameraPointRef.current = playbackCameraTarget.point;
    lastStableBearingRef.current = stableBearing;

    map.jumpTo({
      center: [
        map.getCenter().lng + (playbackCameraTarget.point.lon - map.getCenter().lng) * FLYOVER_CENTER_SMOOTHING,
        map.getCenter().lat + (playbackCameraTarget.point.lat - map.getCenter().lat) * FLYOVER_CENTER_SMOOTHING,
      ],
      bearing: interpolateBearing(currentBearing, stableBearing, FLYOVER_BEARING_SMOOTHING),
      zoom: interpolateValue(map.getZoom(), FLYOVER_CAMERA_ZOOM, FLYOVER_ZOOM_SMOOTHING),
      pitch: interpolateValue(map.getPitch(), targetPitch, FLYOVER_PITCH_SMOOTHING),
    });
  }, [isPlaying, map, playbackBearing, playbackCameraTarget, playbackRoutePoint]);

  useEffect(() => {
    if (!map || !isPlaying || !playbackRoutePoint || !playbackCameraTarget) return;
    if (primedPlaybackSessionRef.current === playbackSessionId) return;
    primedPlaybackSessionRef.current = playbackSessionId;

    const reliefStrengthM = Math.max(
      Math.abs(playbackCameraTarget.elevationDeltaM ?? 0),
      Math.abs(playbackCameraTarget.elevationRangeM ?? 0),
    );
    const targetPitch =
      FLYOVER_CAMERA_PITCH +
      (reliefStrengthM >= FLYOVER_RELIEF_ENGAGE_THRESHOLD_M
        ? clampPitchOffset(-(playbackCameraTarget.smoothedGradientPct ?? 0) * 0.11)
        : 0);

    map.easeTo({
      center: [playbackCameraTarget.point.lon, playbackCameraTarget.point.lat],
      zoom: Math.max(map.getZoom(), FLYOVER_CAMERA_ZOOM),
      pitch: Math.max(map.getPitch(), targetPitch),
      bearing: lastStableBearingRef.current ?? playbackCameraTarget.bearing ?? playbackBearing ?? map.getBearing(),
      duration: 1600,
      essential: true,
    });
  }, [isPlaying, map, playbackBearing, playbackCameraTarget, playbackRoutePoint, playbackSessionId]);

  useEffect(() => {
    if (!map) return;
    return () => {
      if (hoverSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(hoverSyncFrameRef.current);
        hoverSyncFrameRef.current = null;
      }
      lastHoverMarkerRef.current = null;
      clearAnalysisHoverPoint(map);
      clearAnalysisFlyoverProgress(map);
    };
  }, [map]);

  const totalPlaybackDurationSeconds = baseDurationMs / 1000 / speedMultiplier;
  const playbackProgress01 =
    playbackDistanceM != null && totalDistanceM > 0 ? clampDistanceM(playbackDistanceM, totalDistanceM) / totalDistanceM : 0;
  const currentPlaybackSeconds = playbackProgress01 * totalPlaybackDurationSeconds;

  const distanceLabel = playbackDistanceM != null
    ? `${(playbackDistanceM / 1000).toFixed(1)} / ${(totalDistanceM / 1000).toFixed(1)} km`
    : totalDistanceM > 0
      ? formatDistanceLabel(totalDistanceM)
      : 'Aucun trace';

  const predictedElapsedSeconds =
    playbackDistanceM != null
      ? elapsedSecondsAtDistance(prediction, playbackDistanceM, totalDistanceM)
      : null;

  const timeLabel = playbackDistanceM != null
    ? `${speedMultiplier}x · ${formatPlaybackClock(currentPlaybackSeconds)} / ${formatPlaybackClock(totalPlaybackDurationSeconds)}`
    : predictedElapsedSeconds != null
      ? `${speedMultiplier}x · ${formatPlaybackClock(predictedElapsedSeconds)}`
      : `${speedMultiplier}x · ${formatPlaybackClock(totalPlaybackDurationSeconds)}`;

  const togglePlayback = () => {
    if (!canPlay || totalDistanceM <= 0) return;
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }

    const currentDistanceM = playbackDistanceRef.current;
    const shouldRestart = currentDistanceM == null || currentDistanceM >= totalDistanceM - 0.25;
    const nextDistanceM = shouldRestart ? 0 : currentDistanceM;
    setPlaybackDistanceM(nextDistanceM);
    setManualHoverXValue(null);
    playbackDistanceRef.current = nextDistanceM;
    reliefPitchOffsetRef.current = 0;
    setIsPlaying(true);
    setPlaybackSessionId((value) => value + 1);
  };

  const slowDown = () => {
    setSpeedIndex((currentIndex) => {
      const nextIndex = Math.max(0, currentIndex - 1);
      if (nextIndex !== currentIndex && isPlaying) {
        setPlaybackSessionId((value) => value + 1);
      }
      return nextIndex;
    });
  };

  const speedUp = () => {
    setSpeedIndex((currentIndex) => {
      const nextIndex = Math.min(SPEED_STEPS.length - 1, currentIndex + 1);
      if (nextIndex !== currentIndex && isPlaying) {
        setPlaybackSessionId((value) => value + 1);
      }
      return nextIndex;
    });
  };

  const resetPlayback = () => {
    setIsPlaying(false);
    setManualHoverXValue(null);
    setPlaybackDistanceM(canPlay ? 0 : null);
    playbackDistanceRef.current = canPlay ? 0 : null;
  };

  const value = useMemo<AnalysisFlyoverContextValue>(
    () => ({
      canPlay,
      isPlaying,
      playbackActive,
      controlledHoverXValue,
      setManualHoverXValue,
      togglePlayback,
      slowDown,
      speedUp,
      resetPlayback,
      canSlowDown: speedIndex > 0,
      canSpeedUp: speedIndex < SPEED_STEPS.length - 1,
      distanceLabel,
      timeLabel,
      speedLabel: `${speedMultiplier}x`,
    }),
    [
      canPlay,
      controlledHoverXValue,
      distanceLabel,
      isPlaying,
      playbackActive,
      speedIndex,
      speedMultiplier,
      timeLabel,
    ],
  );

  return (
    <AnalysisFlyoverContext.Provider value={value}>
      {children}
    </AnalysisFlyoverContext.Provider>
  );
}

export function useAnalysisFlyover(): AnalysisFlyoverContextValue {
  const context = useContext(AnalysisFlyoverContext);
  if (!context) {
    throw new Error('useAnalysisFlyover must be used within <AnalysisFlyoverProvider>');
  }
  return context;
}

function interpolateValue(current: number, target: number, amount: number): number {
  return current + (target - current) * amount;
}

function interpolateBearing(current: number, target: number, amount: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return current + delta * amount;
}

function angularDeltaDegrees(left: number, right: number): number {
  return Math.abs(((right - left + 540) % 360) - 180);
}

function clampPitchOffset(value: number): number {
  return Math.max(-2.4, Math.min(2.4, value));
}

function smoothReliefPitchOffset(current: number, target: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= FLYOVER_RELIEF_PITCH_DEADBAND_DEG) return current;

  const smoothing = Math.abs(target) > Math.abs(current)
    ? FLYOVER_RELIEF_PITCH_ATTACK_SMOOTHING
    : FLYOVER_RELIEF_PITCH_RELEASE_SMOOTHING;
  const steppedDelta = clampValue(
    delta * smoothing,
    -FLYOVER_RELIEF_PITCH_MAX_STEP_DEG,
    FLYOVER_RELIEF_PITCH_MAX_STEP_DEG,
  );

  return current + steppedDelta;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}