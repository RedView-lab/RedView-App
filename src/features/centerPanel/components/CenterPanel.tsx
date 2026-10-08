import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Map as MapboxMap } from 'mapbox-gl';
import { useAppI18n } from '@/shared/i18n';
import { CenterPanelAnalysis } from './analysis';
import { CenterPanelSummary } from './summary';
import type { TimelineFilterState } from '@/features/itineraryPanel/sections/timeline/TimelineFilters';
import '../styles/index.css';

interface CenterPanelProps {
  map: MapboxMap | null;
  globalFilters?: TimelineFilterState;
  /** Canvas bas : padding et espacements plus serrés (le tableau de bord peut ne lui donner que 240 px). */
  compact?: boolean;
}

export const CenterPanel = memo(function CenterPanel({ map, globalFilters, compact = false }: CenterPanelProps) {
  const { t } = useAppI18n();
  const [fullscreen, setFullscreen] = useState(false);
  const dockRef = useRef<HTMLElement>(null);
  const [fullscreenShell, setFullscreenShell] = useState<HTMLElement | null>(null);
  // Résumé + analyse sont rendus une fois, dans un nœud déplacé entre le panneau
  // ancré et le plein écran : pas de remontage (état du graphique, sélection) ni
  // seconde copie des marqueurs de carte de l'analyse.
  const [content] = useState(() => {
    const node = document.createElement('div');
    node.className = 'rvc-center-panel__content';
    return node;
  });

  useLayoutEffect(() => {
    const target = fullscreen ? fullscreenShell : dockRef.current;
    if (target && content.parentNode !== target) target.appendChild(content);
  }, [content, fullscreen, fullscreenShell]);

  // Même contrat que le plein écran de la feuille de route : Échap ferme, la page
  // derrière ne défile pas. Un Échap déjà consommé (menu, renommage) non.
  useEffect(() => {
    if (!fullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setFullscreen(false);
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [fullscreen]);

  const handleToggleFullscreen = useCallback(() => setFullscreen((current) => !current), []);

  return (
    <>
      <aside
        ref={dockRef}
        className={`rvc-center-panel${compact ? ' rvc-center-panel--compact' : ''}`}
        aria-label={t("Panneau central d'analyse")}
      >
        {createPortal(
          <>
            <CenterPanelSummary fullscreen={fullscreen} onToggleFullscreen={handleToggleFullscreen} />
            <div className="rvc-center-panel__divider" />
            <CenterPanelAnalysis map={map} globalFilters={globalFilters} />
          </>,
          content,
        )}
      </aside>

      {fullscreen
        ? createPortal(
          <div className="rvi-panel-fullscreen-root rv-app-scaled-layer">
            <aside
              ref={setFullscreenShell}
              className="rvc-center-panel rvc-center-panel--fullscreen"
              role="dialog"
              aria-modal
              aria-label={t("Panneau central d'analyse en plein écran")}
            />
          </div>,
          document.body,
        )
        : null}
    </>
  );
});
