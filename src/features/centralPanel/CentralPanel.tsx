/**
 * Central Panel — pure presentational composition.
 *
 * The container owns state; this view simply wires sections together and
 * exposes a stable shell (resize handle, glass background).
 */
import { useMemo } from 'react';

import { SynthesisTable } from './sections/SynthesisTable/SynthesisTable';
import { AnalysisToolbar } from './sections/AnalysisToolbar/AnalysisToolbar';
import { ChartCard } from './sections/ChartCard/ChartCard';
import { ZoomScrollbar } from './sections/ZoomScrollbar/ZoomScrollbar';
import { xExtent, visibleSeries } from './sections/ProfileChart/scales';
import type { CentralPanelProps } from './types';
import './styles/index.css';

export function CentralPanel(props: CentralPanelProps) {
  const {
    itineraries,
    ui,
    markers,
    dayNight,
    className,
    style,
    onResizeStart,
    onResizeLeftStart,
    onResizeRightStart,
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
        <ChartCard
          itineraries={itineraries}
          ui={ui}
          markers={markers}
          dayNight={dayNight}
          onHover={onHover}
          onAddTemperatureRow={onAddTemperatureRow}
          onRemoveTemperatureRow={onRemoveTemperatureRow}
          onChangeTemperatureMode={onChangeTemperatureMode}
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

      {onResizeLeftStart ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner depuis la gauche"
          className="rvc-panel__resize-handle--left"
          onMouseDown={onResizeLeftStart}
        />
      ) : null}

      {onResizeRightStart ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner depuis la droite"
          className="rvc-panel__resize-handle--right"
          onMouseDown={onResizeRightStart}
        />
      ) : null}
    </section>
  );
}
