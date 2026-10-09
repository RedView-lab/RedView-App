// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { axeViolations } from '@/shared/test/axe';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { SettingsPanel } from './SettingsPanel';

/**
 * Accessibilité (axe, WCAG A/AA) des Réglages ajoutés le 2026-10-09 :
 * « Mesure d'audience » (interrupteur) et « Sources des données ».
 * e2e:journey audite les réglages, mais sans ouvrir ces sections ni lire
 * l'interrupteur au lecteur d'écran.
 */

let view: RenderedComponent | null = null;
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  view?.unmount();
  view = null;
});

describe('Réglages : accessibilité', () => {
  it('panneau entier : aucune violation', async () => {
    view = renderComponent(createElement(SettingsPanel));
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('« Mesure d’audience » : interrupteur natif, nommé, décrit, état annoncé', () => {
    view = renderComponent(createElement(SettingsPanel));
    const toggle = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    // <button> : tabulable, Espace et Entrée l'actionnent sans code maison.
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.tabIndex).toBe(0);
    const labelledBy = document.getElementById(toggle.getAttribute('aria-labelledby') ?? '');
    const describedBy = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(labelledBy?.textContent).toBe('Mesure d’audience');
    expect(describedBy?.textContent).toMatch(/^Statistiques de visite anonymes/);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    view.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('« Sources des données » : titres hiérarchisés, chaque licence est un lien nommé', () => {
    view = renderComponent(createElement(SettingsPanel));
    const section = view.container.querySelector<HTMLElement>('.rvpb-settings-sources')!;
    expect(section.getAttribute('aria-labelledby')).toBeTruthy();
    expect(section.querySelector('h2')).not.toBeNull();
    const links = [...section.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect((link.textContent ?? '').trim()).not.toBe('');
  });
});
