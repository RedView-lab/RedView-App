import { CenterPanelAnalysis } from './components/CenterPanelAnalysis';
import { CenterPanelSummary } from './components/CenterPanelSummary';
import { CenterPanelToolbar } from './components/CenterPanelToolbar';
import './styles/index.css';

export function CenterPanel() {
  return (
    <aside className="rvc-center-panel" aria-label="Panneau central d'analyse">
      <CenterPanelToolbar />
      <CenterPanelSummary />
      <div className="rvc-center-panel__divider" />
      <CenterPanelAnalysis />
    </aside>
  );
}
