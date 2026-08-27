/**
 * Mutual-exclusion bridge between the analysis-zone drawing tool and the
 * other armed map tools (trace / split / merge / forbidden zones).
 *
 * The AnalysisZoneProvider sits ABOVE the tool providers in the tree (it must
 * wrap MapViewportControls, which lives outside ProjectProvider), so it cannot
 * reach their contexts. This component is mounted INSIDE them and wires the
 * exclusion in both directions:
 *   • arming the zone tool disarms any active map tool;
 *   • arming a map tool cancels an in-progress zone drawing.
 */

import { useEffect } from 'react';

import { useForbiddenZoneToolOptional } from '@/features/centerPanel/forbiddenZones';
import { useRouteMergeToolOptional } from '@/features/centerPanel/routeMerge';
import { useRouteSplitToolOptional } from '@/features/centerPanel/routeSplit';
import { useTraceToolOptional } from '@/features/centerPanel/tracer';

import { useAnalysisZone } from './AnalysisZoneContext';

export function AnalysisZoneToolArbiter() {
  const analysisZone = useAnalysisZone();
  const traceTool = useTraceToolOptional();
  const splitTool = useRouteSplitToolOptional();
  const mergeTool = useRouteMergeToolOptional();
  const forbiddenZoneTool = useForbiddenZoneToolOptional();

  const isDrawing = analysisZone?.isDrawing ?? false;
  const cancelDrawing = analysisZone?.cancelDrawing;

  const otherToolArmed = Boolean(
    traceTool?.armed
    || splitTool?.armed
    || mergeTool?.armed
    || forbiddenZoneTool?.armed,
  );

  // Zone drawing armed → disarm every other map tool.
  useEffect(() => {
    if (!isDrawing) return;
    if (traceTool?.armed) traceTool.deactivate();
    if (splitTool?.armed) splitTool.deactivate();
    if (mergeTool?.armed) mergeTool.deactivate();
    if (forbiddenZoneTool?.armed) forbiddenZoneTool.deactivate();
    // The deactivations above re-render with fresh context values; running
    // this effect only on the isDrawing transition keeps it one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrawing]);

  // Another tool armed → cancel an in-progress zone drawing.
  useEffect(() => {
    if (!otherToolArmed) return;
    if (isDrawing) cancelDrawing?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherToolArmed]);

  return null;
}
