// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppI18nContext, type AppI18nContextValue } from '@/shared/i18n/appI18nContext';
import { axeViolations } from '@/shared/test/axe';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { LEGAL_PAGES } from '../lib/routes';
import { LegalLinks } from './LegalLinks';
import { LegalPage } from './LegalPage';

/**
 * Accessibilité (axe, WCAG A/AA) des pages légales, en français et en
 * anglais, et de leurs liens : e2e:journey ne les ouvre pas. Clavier : tout
 * est lien natif (tabulable, Entrée), aucun élément interactif maison.
 */

const english = { locale: 'en', setLocale: () => {}, t: (text: string) => text, bundle: { entries: [] } } as unknown as AppI18nContextValue;
const inEnglish = (element: ReactElement) => createElement(AppI18nContext.Provider, { value: english }, element);

let view: RenderedComponent | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

describe('pages légales : accessibilité', () => {
  for (const { id } of LEGAL_PAGES) {
    for (const locale of ['fr', 'en'] as const) {
      it(`${id} (${locale}) : aucune violation, un seul h1, langue déclarée`, async () => {
        const page = createElement(LegalPage, { page: id });
        view = renderComponent(locale === 'en' ? inEnglish(page) : page);
        const root = view.container.querySelector<HTMLElement>('.rv-legal')!;
        expect(await axeViolations(root)).toEqual([]);
        expect(root.querySelectorAll('h1')).toHaveLength(1);
        expect(root.getAttribute('lang')).toBe(locale);
        // Tout ce qui se clique est un vrai lien (clavier natif), et a un nom.
        for (const link of root.querySelectorAll('a')) {
          expect(link.getAttribute('href')).toBeTruthy();
          expect((link.textContent ?? '').trim() || link.getAttribute('aria-label')).toBeTruthy();
        }
      });
    }
  }

  it('liens légaux de l’écran de connexion et des Réglages : navigation nommée, aucune violation', async () => {
    view = renderComponent(createElement(LegalLinks));
    const nav = view.container.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBeTruthy();
    expect(await axeViolations(nav)).toEqual([]);
  });
});
