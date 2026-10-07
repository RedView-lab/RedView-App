import { describe, expect, it } from 'vitest';

import { diffControlPanelForAnalytics } from './controlPanelAnalytics';
import { createDefaultControlPanelPersistedState } from './persistedState';

describe('diffControlPanelForAnalytics', () => {
  it('une couche basculée, un fond de carte changé : un événement chacun', () => {
    const prev = createDefaultControlPanelPersistedState();
    const next = structuredClone(prev);
    next.toggles.slopesEnabled = true;
    next.toggles.labelsEnabled = false;
    next.basemapId = 'topographic';
    expect(diffControlPanelForAnalytics(prev, next)).toEqual([
      { name: 'layer_toggled', data: { layer: 'labels', enabled: false } },
      { name: 'layer_toggled', data: { layer: 'slopes', enabled: true } },
      { name: 'basemap_changed', data: { basemap: 'topographic' } },
    ]);
  });

  it('écriture sans changement, état précédent inconnu, id de fond hors format : rien', () => {
    const prev = createDefaultControlPanelPersistedState();
    expect(diffControlPanelForAnalytics(prev, structuredClone(prev))).toEqual([]);
    expect(diffControlPanelForAnalytics(null, prev)).toEqual([]);
    const next = structuredClone(prev);
    next.basemapId = 'https://tiles.example.com/{z}/{x}/{y}.png';
    expect(diffControlPanelForAnalytics(prev, next)).toEqual([]);
  });
});
