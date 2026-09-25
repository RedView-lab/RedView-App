import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import type { AxisMode } from '../series';
import { projectElapsedHoursToX } from '../seriesPredictionMath';

export interface ChartPauseWindow {
  id: string;
  startX: number;
  endX: number;
  durationMin?: number;
  label?: string;
}

export interface ChartPauseOverlay {
  pauseWindows: ChartPauseWindow[];
}

interface BuildChartPauseOverlayOptions {
  itinerary: Itinerary;
  prediction: PredictionResult | null | undefined;
  xMode: AxisMode;
}

export function buildChartPauseOverlay({
  itinerary,
  prediction,
  xMode,
}: BuildChartPauseOverlayOptions): ChartPauseOverlay | null {
  if (xMode === 'distance' || !itinerary || !prediction) return null;

  const schedule = buildPauseAwareSchedule(itinerary, prediction);
  if (!schedule || schedule.pauseSpans.length === 0) return null;

  const startTime = itinerary.rhythm?.startTime;
  const pauseWindows: ChartPauseWindow[] = [];

  for (let index = 0; index < schedule.pauseSpans.length; index += 1) {
    const span = schedule.pauseSpans[index]!;
    const startX = projectElapsedHoursToX(span.startScheduledSeconds / 3600, xMode, startTime);
    const endX = projectElapsedHoursToX(span.endScheduledSeconds / 3600, xMode, startTime);

    if (!Number.isFinite(startX) || !Number.isFinite(endX) || endX - startX <= 1e-4) {
      continue;
    }

    pauseWindows.push({
      id: span.id ?? `pause-window-${index + 1}`,
      startX,
      endX,
      durationMin: span.durationMin ?? Math.round(span.durationSeconds / 60),
      label: span.label ?? 'Pause',
    });
  }

  if (pauseWindows.length === 0) return null;

  return { pauseWindows };
}
