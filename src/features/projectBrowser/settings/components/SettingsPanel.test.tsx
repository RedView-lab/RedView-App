// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_BROWSER_SETTINGS_STORAGE_KEY } from '@/shared/i18n';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { SettingsPanel } from './SettingsPanel';

/**
 * Réglages : seuls ceux que l'app lit vraiment sont proposés (langue,
 * affichage). Les anciens « Unité de mesure », « Paramètre de carte » et
 * « Réglage » étaient enregistrés mais lus nulle part.
 */

let view: RenderedComponent | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('SettingsPanel', () => {
  it('ne propose plus de réglage sans effet', () => {
    view = renderComponent(createElement(SettingsPanel));
    const labels = [...view.container.querySelectorAll('.rvpb-settings-row__label')].map((node) => node.textContent);
    expect(labels).toEqual(['Langue', 'Préférence d’affichage']);
    expect(view.container.querySelector('[role="switch"]')).toBeNull();
  });

  it('les anciennes clés stockées sont lues sans erreur puis abandonnées, le thème et la langue gardés', () => {
    window.localStorage.setItem(
      PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
      JSON.stringify({ language: 'fr', unit: 'Pieds', mapPreset: 'Nuit', displayMode: 'dark', communityPromptEnabled: false }),
    );
    view = renderComponent(createElement(SettingsPanel));
    const stored = JSON.parse(window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored).toEqual({ language: 'fr', displayMode: 'dark' });
  });
});
