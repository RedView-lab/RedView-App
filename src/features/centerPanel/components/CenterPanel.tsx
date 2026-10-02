import { memo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useAppI18n } from '@/shared/i18n';
import { CenterPanelAnalysis } from './analysis';
import { CenterPanelSummary } from './summary';
import type { TimelineFilterState } from '@/features/itineraryPanel/sections/timeline/TimelineFilters';
import '../styles/index.css';

interface CenterPanelProps {
  map: MapboxMap | null;
  globalFilters?: TimelineFilterState;
  /** Short canvas: tighter padding and gaps (the dashboard may give it only 240 px). */
  compact?: boolean;
}

export const CenterPanel = memo(function CenterPanel({ map, globalFilters, compact = false }: CenterPanelProps) {
  const { t } = useAppI18n();

  return (
    <aside className={`rvc-center-panel${compact ? ' rvc-center-panel--compact' : ''}`} aria-label={t("Panneau central d'analyse")}>
      <CenterPanelSummary />
      <div className="rvc-center-panel__divider" />
      <CenterPanelAnalysis map={map} globalFilters={globalFilters} />
    </aside>
  );
});
