/**
 * Central Panel — pure presentational composition.
 *
 * The container owns state; this view simply wires sections together and
 * exposes a stable shell (resize handle, glass background).
 */
import { useMemo } from 'react';

import { SynthesisTable } from './sections/SynthesisTable/SynthesisTable';
import { AnalysisToolbar } from './sections/AnalysisToolbar/AnalysisToolbar';
import { ProfileChart } from './sections/ProfileChart/ProfileChart';
import { ChartXAxis } from './sections/ProfileChart/ChartXAxis';
import { TemperatureRows } from './sections/TemperatureRows/TemperatureRows';
import { ZoomScrollbar } from './sections/ZoomScrollbar/ZoomScrollbar';
import { xExtent } from './sections/ProfileChart/scales';
import { visibleSeries } from './sections/ProfileChart/scales';
import type { CentralPanelProps } from './types';
import './styles/index.css';

const CHART_PADDING_LEFT = 56;
const CHART_PADDING_RIGHT = 56;
const X_TICK_TARGET = 11;

export function CentralPanel(props: CentralPanelProps) {
  const {
    itineraries,
    ui,
    markers,
    dayNight,
    className,
    style,
    onResizeStart,
    isResizing,
    onToggleVisibility,
    onRowAction,
    onOpenSettings,
    selectedItineraryId,
    onSelectItinerary,
    onChangeAxis1,
    onChangePrimaryMetric,
    onChangeSecondaryMetric,
    onChangeDetail,
    onToggleOverlay,
    onHover,
    onAddTemperatureRow,
    onRemoveTemperatureRow,
    onChangeTemperatureMode,
    onChangeZoom,
  } = props;

  const xDomain = useMemo<[number, number]>(() => {
    const all = [
      ...visibleSeries(itineraries, 'primary'),
      ...visibleSeries(itineraries, 'secondary'),
    ].map((s) => s.samples);
    return ui.zoomRangeKm ?? xExtent(all);
  }, [itineraries, ui.zoomRangeKm]);

  const totalKm = useMemo(() => {
    const all = visibleSeries(itineraries, 'primary').map((s) => s.samples);
    return xExtent(all)[1];
  }, [itineraries]);

  return (
    <section
      className={`rvc-panel${isResizing ? ' is-resizing' : ''}${
        className ? ` ${className}` : ''
      }`}
      style={style}
      aria-label="Panneau central — analyse d'itinéraires"
    >
      <SynthesisTable
        itineraries={itineraries}
        selectedId={selectedItineraryId ?? itineraries[0]?.id ?? null}
        onSelect={onSelectItinerary}
        onToggleVisibility={onToggleVisibility}
        onRowAction={onRowAction}
        onOpenSettings={onOpenSettings}
      />

      <div className="rvc-panel__divider" />

      <AnalysisToolbar
        ui={ui}
        onChangeAxis1={onChangeAxis1}
        onChangePrimaryMetric={onChangePrimaryMetric}
        onChangeSecondaryMetric={onChangeSecondaryMetric}
        onChangeDetail={onChangeDetail}
        onToggleOverlay={onToggleOverlay}
      />

      <div className="rvc-panel__chart-area">
        <ProfileChart
          itineraries={itineraries}
          ui={ui}
          markers={markers}
          dayNight={dayNight}
          onHover={onHover}
        />

        <ChartXAxis
          domain={xDomain}
          unit={ui.axis1 === 'distance' ? 'km' : 's'}
          targetCount={X_TICK_TARGET}
          paddingLeft={CHART_PADDING_LEFT}
          paddingRight={CHART_PADDING_RIGHT}
        />

        <TemperatureRows
          itineraries={itineraries}
          binCount={X_TICK_TARGET}
          paddingLeft={CHART_PADDING_LEFT}
          paddingRight={CHART_PADDING_RIGHT}
          onChangeMode={onChangeTemperatureMode}
          onRemoveRow={onRemoveTemperatureRow}
          onAddRow={onAddTemperatureRow}
        />
      </div>

      <ZoomScrollbar
        totalKm={totalKm}
        range={ui.zoomRangeKm}
        onChangeRange={onChangeZoom}
      />

      {onResizeStart ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionner le panneau"
          className={`rvc-panel__resize-handle${isResizing ? ' is-dragging' : ''}`}
          onMouseDown={onResizeStart}
        />
      ) : null}
    </section>
  );
}
