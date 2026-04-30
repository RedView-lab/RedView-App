import type { Map as MapboxMap } from 'mapbox-gl';
import { CenterPanelAnalysis } from './analysis';
import { CenterPanelSummary } from './summary';
import '../styles/index.css';

interface CenterPanelProps {
  map: MapboxMap | null;
}

export function CenterPanel({ map }: CenterPanelProps) {
  return (
    <aside className="rvc-center-panel" aria-label="Panneau central d'analyse">
      <CenterPanelSummary />
      <div className="rvc-center-panel__divider" />
      <CenterPanelAnalysis map={map} />
    </aside>
  );
}
