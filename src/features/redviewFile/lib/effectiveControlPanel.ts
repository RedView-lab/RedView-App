/**
 * Réglages de calques tels que les voit l'expéditeur.
 *
 * Faute de valeur dans le projet, le panneau de droite lit certains réglages
 * dans les préférences GLOBALES du navigateur (localStorage) : pentes
 * (useTerrainSlopeState), altitude (useTerrainAltitudeState), étiquettes
 * (useOverlayLabelsState). Un projet jamais réglé afficherait donc chez le
 * destinataire SES préférences, pas celles de l'expéditeur : on les fige dans
 * le fichier avec les mêmes valeurs initiales que les hooks.
 */
import { loadAltitudeBreakpoints, loadAltitudeState } from '@/features/altitude/lib/altitude-persist';
import {
  createDefaultControlPanelPersistedState,
  type ControlPanelPersistedState,
} from '@/features/controlPanel/lib/persistedState';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { loadLabelState } from '@/features/labels/lib/label-persist';
import { loadBreakpoints, loadSlopeState, migrateLegacyResolution } from '@/features/slope/lib/slope-persist';

/** Valeurs initiales de useTerrainSlopeState sans `slopes` dans le projet. */
const SLOPE_DEFAULT_SCALE_SETTING = '10 couleurs';
const SLOPE_DEFAULT_BAND_COUNT = 10;

export function withEffectiveControlPanel(project: ItineraryProject): ItineraryProject {
  const base = project.controlPanel ?? createDefaultControlPanelPersistedState();
  if (project.controlPanel && base.slopes && base.altitude && base.labelsState) return project;

  const controlPanel: ControlPanelPersistedState = { ...base, toggles: { ...base.toggles } };

  if (!controlPanel.slopes) {
    const loaded = loadSlopeState();
    controlPanel.slopes = {
      state: {
        ...loaded,
        resolution: (migrateLegacyResolution(loaded.resolution) ?? loaded.resolution) ?? 'auto',
        enabled: base.toggles.slopesEnabled ?? loaded.enabled,
      },
      scale: 'percent',
      scaleSetting: SLOPE_DEFAULT_SCALE_SETTING,
      bandVisibility: {},
      customColors: {},
      breakpoints: { bandCount: SLOPE_DEFAULT_BAND_COUNT, byCount: loadBreakpoints().byCount },
    };
  }

  if (!controlPanel.altitude) {
    const loaded = loadAltitudeState();
    controlPanel.altitude = {
      state: { ...loaded, enabled: base.toggles.altitudeEnabled ?? loaded.enabled },
      breakpoints: loadAltitudeBreakpoints(),
    };
  }

  if (!controlPanel.labelsState) {
    const backend = loadLabelState();
    controlPanel.labelsState = { backend, statesUiEnabled: backend.states };
  }

  return { ...project, controlPanel };
}
