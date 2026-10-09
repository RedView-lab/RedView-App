// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_BROWSER_SETTINGS_STORAGE_KEY } from '@/shared/i18n';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { SettingsPanel } from './SettingsPanel';

/**
 * Réglages : seuls ceux que l'app lit vraiment sont proposés (langue,
 * affichage, mesure d'audience). Les anciens « Unité de mesure », « Paramètre
 * de carte » et « Réglage » étaient enregistrés mais lus nulle part.
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
    expect(labels).toEqual(['Langue', 'Préférence d’affichage', 'Mesure d’audience']);
    expect(view.container.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });

  it('la mesure d’audience se refuse et se réactive sur l’appareil (clé relue par le tracker)', () => {
    view = renderComponent(createElement(SettingsPanel));
    const toggle = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    view.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(window.localStorage.getItem('umami.disabled')).toBe('1');
    view.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem('umami.disabled')).toBeNull();
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
