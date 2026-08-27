import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { AxisDomain, AxisMode } from '../components/chart';
import {
  buildCinematicCameraTarget,
  cinematicBearingAtDistance,
  buildRoutePlaybackGeometry,
  buildRouteTrailCoordinates,
  clampDistanceM,
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
  getItineraryStartDistanceKm,
} from '@/features/itineraryPanel/lineage/itineraryLineage';
import {
  clearAnalysisFlyoverProgress,
  setRouteLayerVisibility,
  setAnalysisFlyoverProgress,
} from '@/features/itineraryPanel/lib/route-layer';
import {
  DEFAULT_SPEED_INDEX,
  FLYOVER_MAX_DURATION_MS,
  FLYOVER_MIN_DURATION_MS,
  FLYOVER_REFERENCE_DISTANCE_KM,
  FLYOVER_REFERENCE_DURATION_MS,
  SPEED_STEPS,
  type AnalysisFlyoverContextValue,
} from './types';
import { useFlyoverCamera } from './useFlyoverCamera';
import { useFlyoverHoverMarker } from './useFlyoverHoverMarker';

export * from './types';

const AnalysisFlyoverContext = createContext<AnalysisFlyoverContextValue | null>(null);

interface AnalysisFlyoverProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

/**
 * Fournisseur de contexte pour l'animation Flyover 3D le long de l'itinéraire actif.
 */
export function AnalysisFlyoverProvider({
  children,
  map,
}: AnalysisFlyoverProviderProps) {
  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const project = projectStore?.project ?? null;
  const itineraries = project?.itineraries ?? [];
  const activeItineraryId = project?.activeItineraryId ?? null;
  const predictions = predictionStore?.predictions ?? null;
  const [playbackDistanceM, setPlaybackDistanceM] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX);
  const [playbackSessionId, setPlaybackSessionId] = useState(0);
  const playbackDistanceRef = useRef<number | null>(null);

  const interactiveItinerary = useMemo(() => {
    if (itineraries.length === 0) return null;
    const active =
      itineraries.find((itinerary) => itinerary.id === activeItineraryId) ??
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
  }, [activeItineraryId, itineraries]);

  const xMode = ((project?.analysis?.xMode as AxisMode | undefined) ??
    'distance') as AxisMode;
  const routePoints = interactiveItinerary?.gpxRoute?.points ?? null;
  const prediction =
    interactiveItinerary != null
      ? predictions?.[interactiveItinerary.id] ?? interactiveItinerary.prediction ?? null
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

  const { resetCameraState } = useFlyoverCamera({
    map,
    isPlaying,
    playbackSessionId,
    playbackRoutePoint,
    playbackBearing,
    playbackCameraTarget,
  });

  const { setManualHoverXValue } = useFlyoverHoverMarker();

  useEffect(() => {
    setIsPlaying(false);
    setPlaybackDistanceM(null);
    setManualHoverXValue(null);
    setSpeedIndex(DEFAULT_SPEED_INDEX);
    resetCameraState();
  }, [itineraryId, resetCameraState, setManualHoverXValue]);

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
    return localXValue + getItineraryStartDistanceKm(interactiveItinerary ?? (undefined as never));
  }, [interactiveItinerary, playbackDistanceM, prediction, startTime, totalDistanceM, xMode]);

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
    if (!map) return;
    return () => {
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
      setManualHoverXValue,
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