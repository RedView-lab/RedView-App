export {
  AnalysisZoneProvider,
  useAnalysisZone,
  type AnalysisZoneContextValue,
  type AnalysisWidgetId,
} from './AnalysisZoneContext';
export { AnalysisZoneProjectBridge } from './AnalysisZoneProjectBridge';
export { AnalysisZoneToolArbiter } from './AnalysisZoneToolArbiter';
export type { AnalysisZone, AnalysisZonePoint } from './lib/geometry';
export {
  analysisZoneBBox,
  analysisZoneRingPayload,
  analysisZoneSourceBounds,
  hashAnalysisZone,
  isValidAnalysisZone,
} from './lib/geometry';
