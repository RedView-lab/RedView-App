import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AppI18nContext, type AppI18nContextValue } from '@/shared/i18n/appI18nContext';
import { createAppTranslationBundle } from '@/shared/i18n/config';
import { buildTranslationLookup, translateString } from '@/shared/i18n/domTranslation';

/**
 * Rendu de composant pour Vitest sans @testing-library : vraie racine React
 * dans le DOM du test (`// @vitest-environment happy-dom` en tête du fichier),
 * contexte i18n de l'app en français (dictionnaire réel, sans l'observateur
 * DOM), aides pour trouver un bouton par son libellé accessible et cliquer.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const bundle = createAppTranslationBundle('fr');
const lookup = buildTranslationLookup(bundle.entries);
const frenchI18n: AppI18nContextValue = {
  locale: 'fr',
  setLocale: () => {},
  t: (text, vars) => translateString(text, lookup, vars),
  bundle,
};

export interface RenderedComponent {
  readonly container: HTMLElement;
  /** Re-rend la même racine avec un nouvel élément (nouvelles props). */
  rerender(element: ReactElement): void;
  unmount(): void;
  /** Bouton dont l'`aria-label` vaut `label`, ou à défaut dont le texte vaut `label` ; lève s'il manque. */
  button(label: string): HTMLButtonElement;
  /** Clic (événement qui remonte), dans `act`. */
  click(target: Element): void;
}

export function renderComponent(element: ReactElement): RenderedComponent {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);
  const render = (el: ReactElement) => {
    act(() => root?.render(createElement(AppI18nContext.Provider, { value: frenchI18n }, el)));
  };
  render(element);
  return {
    container,
    rerender: render,
    unmount() {
      act(() => root?.unmount());
      root = null;
      container.remove();
    },
    button(label) {
      const byAria = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (byAria) return byAria;
      const byText = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === label);
      if (!byText) throw new Error(`bouton « ${label} » absent`);
      return byText;
    },
    click(target) {
      act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    },
  };
}
