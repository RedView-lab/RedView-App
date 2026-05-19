import type { Map as MapboxMap } from 'mapbox-gl';
import { useAppI18n } from '@/shared/i18n';
import { CenterPanelAnalysis } from './analysis';
import { CenterPanelSummary } from './summary';
import '../styles/index.css';

interface CenterPanelProps {
  map: MapboxMap | null;
}

export function CenterPanel({ map }: CenterPanelProps) {
  const { t } = useAppI18n();

  return (
    <aside className="rvc-center-panel" aria-label={t("Panneau central d'analyse")}>
      <CenterPanelSummary />
      <div className="rvc-center-panel__divider" />
      <CenterPanelAnalysis map={map} />
    </aside>
  );
}
