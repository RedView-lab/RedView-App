// ============================================
// LiDAR viewer tools — React layer (menu, tool hint, profile card, 360° HUD)
// ============================================

import { Fragment, useSyncExternalStore } from 'react';
import { translateAppText as t } from '@/shared/i18n/config';
import { isDrawingTool, type ToolId } from '../types';
import { CloseGlyph } from './glyphs';
import { LookBar, LookCompass, LookReticle } from './LookAroundHud';
import { ProfileCard } from './ProfileCard';
import type { ToolsUiActions, ToolsUiStore } from './toolsUiStore';
import { ViewerContextMenu } from './ViewerContextMenu';
import './styles.css';

const TOOL_NAMES: Record<ToolId, string> = {
  distance: 'Distance',
  height: 'Dénivelé et angle',
  area: 'Surface',
  profile: 'Profil',
  fallLine: 'Ligne de pente',
  avalanche: 'Exposition avalanche',
  viewshed: 'Zones visibles d’ici',
  pin: 'Épingler le point',
};

/** [key, action] pairs of the active tool. */
function toolInstructions(tool: ToolId, vertexCount: number): Array<[string, string]> {
  if (!isDrawingTool(tool)) return [[t('Clic'), t('choisir le point')], [t('Échap'), t('annuler')]];
  if (tool === 'height') {
    return [
      [t('Clic'), vertexCount === 0 ? t('premier point') : t('second point')],
      [t('Alt+clic'), t('sol sous la végétation')],
      [t('Échap'), t('annuler')],
    ];
  }
  return [
    [t('Clic'), t('ajouter un point')],
    [t('Clic droit'), tool === 'area' ? t('fermer') : t('terminer')],
    ['⌫', t('retirer le dernier')],
    [t('Échap'), t('annuler')],
  ];
}

export function ViewerToolsUi({ store, actions }: { store: ToolsUiStore; actions: ToolsUiActions }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const look = state.lookAround;
  return (
    <>
      <div className="rv-lidar-tools-top">
        {look ? <LookCompass model={look} /> : null}
        {state.activeTool || state.notice ? (
          <div className="rv-lidar-tool-hint" role="status">
            {state.activeTool ? (
              <>
                <span className="rv-lidar-tool-hint__name">{t(TOOL_NAMES[state.activeTool])}</span>
                <span className="rv-lidar-tool-hint__steps">
                  {toolInstructions(state.activeTool, state.vertexCount).map(([key, action]) => (
                    <Fragment key={key}>
                      <kbd className="rv-lidar-ctx__kbd">{key}</kbd>
                      <span>{action}</span>
                    </Fragment>
                  ))}
                </span>
                <button
                  type="button"
                  className="rv-lidar-ctx__icon-button rv-lidar-ctx__icon-button--small"
                  onClick={() => actions.cancelTool()}
                  aria-label={t('Annuler l’outil')}
                  title={t('Annuler l’outil')}
                >
                  <CloseGlyph />
                </button>
              </>
            ) : (
              <span className="rv-lidar-tool-hint__steps">{state.notice}</span>
            )}
          </div>
        ) : null}
      </div>

      {look ? <LookReticle model={look} /> : null}

      {state.profile || look ? (
        <div className="rv-lidar-tools-bottom">
          {state.profile ? <ProfileCard key={state.profile.id} model={state.profile} actions={actions} /> : null}
          {look ? <LookBar model={look} actions={actions} /> : null}
        </div>
      ) : null}

      {state.menu ? <ViewerContextMenu model={state.menu} actions={actions} /> : null}
    </>
  );
}
