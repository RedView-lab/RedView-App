import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { getRoutePointDistances, projectXToDistanceM, type AxisMode } from '../components/chart';
import { usePredictionStoreOptional, useProjectStoreOptional } from '@/features/itineraryPanel';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import { FLYOVER_DEFAULT_SPEED_INDEX, FLYOVER_SPEED_STEPS } from './config';
import { AnalysisFlyoverContext, FlyoverControllerContext, FlyoverSeekContext } from './context';
import { playbackDurationForLength } from './engine/laws';
import { FlyoverController } from './FlyoverController';
import { formatDistanceLabel, formatPlaybackClock, xValueFromDistance } from './playback';
import type { AnalysisFlyoverContextValue, FlyoverRouteInput, FlyoverSeekToChartX, FlyoverStatus } from './types';

const IDLE_STATUS: FlyoverStatus = {
  canPlay: false,
  phase: 'idle',
  isPlaying: false,
  playbackActive: false,
  speedIndex: FLYOVER_DEFAULT_SPEED_INDEX,
  distanceM: null,
  totalM: 0,
  elapsedS: 0,
  durationS: playbackDurationForLength(0),
};

const subscribeNothing = () => () => {};
const getIdleStatus = () => IDLE_STATUS;

interface AnalysisFlyoverProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

/**
 * Flyover 3D le long de l'itinéraire actif. Le moteur (`FlyoverController`)
 * vit hors React ; ce fournisseur ne fait que lui passer la trace et la
 * projection vers le graphique, et relaie son statut (≤ 4 Hz).
 */
export function AnalysisFlyoverProvider({ children, map }: AnalysisFlyoverProviderProps) {
  const projectStore = useProjectStoreOptional();
  const predictionStore = usePredictionStoreOptional();
  const project = projectStore?.project ?? null;
  const itineraries = project?.itineraries;
  const activeItineraryId = project?.activeItineraryId ?? null;
  const predictions = predictionStore?.predictions ?? null;

  const itinerary = useMemo(() => {
    if (!itineraries || itineraries.length === 0) return null;
    const playable = (candidate: (typeof itineraries)[number]) =>
      candidate.analysisVisible !== false && (candidate.gpxRoute?.points.length ?? 0) > 1;
    const active = itineraries.find((candidate) => candidate.id === activeItineraryId) ?? null;
    if (active && playable(active)) return active;
    return itineraries.find(playable) ?? null;
  }, [activeItineraryId, itineraries]);

  const xMode = ((project?.analysis?.xMode as AxisMode | undefined) ?? 'distance') as AxisMode;
  const routePoints = itinerary?.gpxRoute?.points ?? null;
  const prediction = itinerary ? predictions?.[itinerary.id] ?? itinerary.prediction ?? null : null;
  const startTime = itinerary?.rhythm.startTime ?? null;
  const itineraryId = itinerary?.id ?? null;
  const color = itinerary?.color || '#ff4d4f';

  const distancesM = useMemo(() => (routePoints ? getRoutePointDistances(routePoints) : null), [routePoints]);
  const totalM = distancesM?.[distancesM.length - 1] ?? 0;
  const pauseSchedule = useMemo(
    () => (itinerary && prediction ? buildPauseAwareSchedule(itinerary, prediction) : null),
    [itinerary, prediction],
  );
  const startOffsetKm = xMode === 'distance' && itinerary ? getItineraryStartDistanceKm(itinerary) : 0;

  const toChartX = useCallback(
    (distanceM: number): number | null => {
      const x = xValueFromDistance(distanceM, { prediction, totalDistanceM: totalM, xMode, startTime, pauseSchedule });
      return Number.isFinite(x) ? x + startOffsetKm : null;
    },
    [pauseSchedule, prediction, startOffsetKm, startTime, totalM, xMode],
  );

  const route = useMemo<FlyoverRouteInput | null>(
    () => (itineraryId && routePoints && distancesM ? { itineraryId, points: routePoints, distancesM, color } : null),
    [color, distancesM, itineraryId, routePoints],
  );

  // Construction sans effet de bord ; l'abonnement à la carte vit dans l'effet.
  const controller = useMemo(() => (map ? new FlyoverController(map) : null), [map]);
  useEffect(() => {
    if (!controller) return undefined;
    controller.connect();
    return () => controller.disconnect();
  }, [controller]);

  useEffect(() => {
    controller?.setInput({ route, toChartX });
  }, [controller, route, toChartX]);

  const status = useSyncExternalStore(
    controller?.subscribeStatus ?? subscribeNothing,
    controller?.getStatus ?? getIdleStatus,
  );

  const seekToChartX = useCallback<FlyoverSeekToChartX>(
    (xValue) => {
      if (!controller || !routePoints || !Number.isFinite(xValue)) return false;
      const distanceM = projectXToDistanceM(routePoints, prediction, xMode, xValue - startOffsetKm, startTime, pauseSchedule);
      return Number.isFinite(distanceM) && controller.seekToDistance(distanceM);
    },
    [controller, pauseSchedule, prediction, routePoints, startOffsetKm, startTime, xMode],
  );

  const value = useMemo<AnalysisFlyoverContextValue>(() => {
    const speed = FLYOVER_SPEED_STEPS[status.speedIndex];
    const distanceLabel =
      status.distanceM != null
        ? `${(status.distanceM / 1000).toFixed(1)} / ${(status.totalM / 1000).toFixed(1)} km`
        : status.totalM > 0
          ? formatDistanceLabel(status.totalM)
          : 'Aucun tracé';
    const timeLabel = status.playbackActive
      ? `${speed}x · ${formatPlaybackClock(status.elapsedS)} / ${formatPlaybackClock(status.durationS)}`
      : `${speed}x · ${formatPlaybackClock(status.durationS)}`;
    return {
      canPlay: status.canPlay && controller != null,
      isPlaying: status.isPlaying,
      playbackActive: status.playbackActive,
      togglePlayback: () => controller?.togglePlayback(),
      slowDown: () => controller?.slowDown(),
      speedUp: () => controller?.speedUp(),
      resetPlayback: () => controller?.reset(),
      canSlowDown: status.speedIndex > 0,
      canSpeedUp: status.speedIndex < FLYOVER_SPEED_STEPS.length - 1,
      distanceLabel,
      timeLabel,
    };
  }, [controller, status]);

  return (
    <FlyoverControllerContext.Provider value={controller}>
      <FlyoverSeekContext.Provider value={seekToChartX}>
        <AnalysisFlyoverContext.Provider value={value}>{children}</AnalysisFlyoverContext.Provider>
      </FlyoverSeekContext.Provider>
    </FlyoverControllerContext.Provider>
  );
}

