import { defaultAnalysisHoverCards, type AnalysisHoverCardData } from './components/AnalysisHoverCards';
import { CenterPanelAnalysis } from './components/CenterPanelAnalysis';
import { CenterPanelSummary } from './components/CenterPanelSummary';
import './styles/index.css';

interface CenterPanelProps {
  analysisHoverCards?: AnalysisHoverCardData[];
}

export function CenterPanel({ analysisHoverCards = defaultAnalysisHoverCards }: CenterPanelProps) {
  return (
    <aside className="rvc-center-panel" aria-label="Panneau central d'analyse">
      <CenterPanelSummary />
      <div className="rvc-center-panel__divider" />
      <CenterPanelAnalysis hoverCards={analysisHoverCards} />
    </aside>
  );
}
