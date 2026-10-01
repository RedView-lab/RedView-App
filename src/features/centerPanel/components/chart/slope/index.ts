export {
  SLOPE_COLOR_CLASSES,
  SLOPE_NEUTRAL_CLASS_INDEX,
  classifyGradientPct,
} from './slopeScale';
export type { SlopeColorClass } from './slopeScale';
export {
  buildSlopeOverlayForItinerary,
  detectSlopeProfile,
  slopeClassAtX,
  slopeGradeAtX,
  summarizeSlopeDistribution,
} from './buildSlopeColorRuns';
export type {
  ChartSlopeOverlay,
  ChartSlopeSegment,
  SlopeProfile,
  SlopeRun,
} from './buildSlopeColorRuns';
