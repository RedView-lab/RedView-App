export {
  SLOPE_COLOR_CLASSES,
  SLOPE_NEUTRAL_CLASS_INDEX,
  classifyGradientPct,
} from './slopeScale';
export type { SlopeColorClass } from './slopeScale';
export {
  buildSlopeOverlayForItinerary,
  detectSlopeProfile,
  pickSlopeLevel,
  slopeSegmentAtX,
  summarizeSlopeDistribution,
} from './buildSlopeColorRuns';
export type {
  ChartSlopeLevel,
  ChartSlopeOverlay,
  ChartSlopeSegment,
  SlopeProfile,
  SlopeProfileLevel,
  SlopeRun,
} from './buildSlopeColorRuns';
