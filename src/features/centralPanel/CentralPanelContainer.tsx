/**
 * Stateful container for the Central Panel.
 *
 * Owns the panel UI state (axes, overlays, zoom) so the view stays pure.
 * Itineraries and markers are still expected to come from a parent (the
 * dashboard) — that boundary is intentional: when the routing engine and
 * weather service are wired in, only this container needs to change.
 *
 * For now `itineraries`, `markers`, `dayNight` default to empty arrays so
 * the panel renders its empty/invitation state as in the Figma "blank
 * session" mock.
 */
import { useCallback, useState } from 'react';

import { CentralPanel } from './CentralPanel';
import {
  DEFAULT_UI_STATE,
  SAMPLE_DAYNIGHT,
  SAMPLE_ITINERARIES_WITH_CURVES,
  SAMPLE_MARKERS,
} from './defaultState';
import type {
  AnalysisAxisX,
  AnalysisAxisYMetric,
  CentralPanelItinerary,
  CentralPanelUiState,
  ChartMarker,
  ChartOverlay,
  DayNightBand,
} from './types';

interface CentralPanelContainerProps {
  itineraries?: CentralPanelItinerary[];
  markers?: ChartMarker[];
  dayNight?: DayNightBand[];

  /** Optional initial UI state override. */
  initialUi?: Partial<CentralPanelUiState>;

  /** Layout. */
  className?: string;
  style?: React.CSSProperties;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  onResizeLeftStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  onResizeRightStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;

  /* External wiring (left for the dashboard / engine). */
  onToggleItineraryVisibility?: (id: string) => void;
  onItineraryAction?: (id: string, action: 'menu') => void;
  onOpenSynthesisSettings?: () => void;
  onAddTemperatureRow?: () => void;
  onRemoveTemperatureRow?: (id: string) => void;
  onChangeTemperatureMode?: (
    id: string,
    mode: 'measured' | 'forecast' | 'custom',
  ) => void;
  onHover?: (xValue: number | null) => void;
}

export function CentralPanelContainer({
  itineraries = SAMPLE_ITINERARIES_WITH_CURVES,
  markers = SAMPLE_MARKERS,
  dayNight = SAMPLE_DAYNIGHT,
  initialUi,
  className,
  style,
  onResizeStart,
  onResizeLeftStart,
  onResizeRightStart,
  isResizing,
  onToggleItineraryVisibility,
  onItineraryAction,
  onOpenSynthesisSettings,
  onAddTemperatureRow,
  onRemoveTemperatureRow,
  onChangeTemperatureMode,
  onHover,
}: CentralPanelContainerProps) {
  const [ui, setUi] = useState<CentralPanelUiState>(() => ({
    ...DEFAULT_UI_STATE,
    ...initialUi,
    overlays: { ...DEFAULT_UI_STATE.overlays, ...(initialUi?.overlays ?? {}) },
  }));

  const [selectedItineraryId, setSelectedItineraryId] = useState<string | null>(
    () => itineraries[0]?.id ?? null,
  );

  const setAxis1 = useCallback(
    (next: AnalysisAxisX) =>
      setUi((prev) => ({ ...prev, axis1: next, axis1Mode: next })),
    [],
  );
  const setPrimary = useCallback(
    (next: AnalysisAxisYMetric) =>
      setUi((prev) => ({ ...prev, primaryMetric: next })),
    [],
  );
  const setSecondary = useCallback(
    (next: AnalysisAxisYMetric) =>
      setUi((prev) => ({ ...prev, secondaryMetric: next })),
    [],
  );
  const setDetail = useCallback(
    (value: number) =>
      setUi((prev) => ({
        ...prev,
        detail: Math.max(0, Math.min(1, value)),
      })),
    [],
  );
  const toggleOverlay = useCallback(
    (overlay: ChartOverlay, enabled: boolean) =>
      setUi((prev) => ({
        ...prev,
        overlays: { ...prev.overlays, [overlay]: enabled },
      })),
    [],
  );
  const setZoom = useCallback(
    (range: [number, number] | null) =>
      setUi((prev) => ({ ...prev, zoomRangeKm: range })),
    [],
  );

  return (
    <CentralPanel
      itineraries={itineraries}
      ui={ui}
      markers={markers}
      dayNight={dayNight}
      className={className}
      style={style}
      onResizeStart={onResizeStart}
      onResizeLeftStart={onResizeLeftStart}
      onResizeRightStart={onResizeRightStart}
      isResizing={isResizing}
      onToggleVisibility={onToggleItineraryVisibility}
      onRowAction={onItineraryAction}
      onOpenSettings={onOpenSynthesisSettings}
      selectedItineraryId={selectedItineraryId}
      onSelectItinerary={setSelectedItineraryId}
      onChangeAxis1={setAxis1}
      onChangePrimaryMetric={setPrimary}
      onChangeSecondaryMetric={setSecondary}
      onChangeDetail={setDetail}
      onToggleOverlay={toggleOverlay}
      onChangeZoom={setZoom}
      onHover={onHover}
      onAddTemperatureRow={onAddTemperatureRow}
      onRemoveTemperatureRow={onRemoveTemperatureRow}
      onChangeTemperatureMode={onChangeTemperatureMode}
    />
  );
}
