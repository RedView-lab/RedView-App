// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { LegalPage } from './LegalPage';
import { LegalLinks } from './LegalLinks';

describe('LegalPage', () => {
  let view: RenderedComponent | null = null;
  afterEach(() => {
    view?.unmount();
    view = null;
  });

  it('affiche le document, la navigation entre les pages et le retour à l’app, à l’abri du traducteur du DOM', () => {
    view = renderComponent(createElement(LegalPage, { page: 'privacy' }));
    const root = view.container.querySelector('.rv-legal')!;
    expect(root.getAttribute('data-rv-no-translate')).toBe('true');
    expect(root.querySelector('h1')?.textContent).toBe('Politique de confidentialité');
    const nav = [...root.querySelectorAll('nav a')];
    expect(nav.map((link) => link.getAttribute('href'))).toEqual(['/mentions-legales', '/confidentialite', '/cgu', '/accessibilite']);
    expect(nav[1].getAttribute('aria-current')).toBe('page');
    expect(root.querySelector('a[href="https://www.cnil.fr"]')?.getAttribute('target')).toBe('_blank');
    expect(document.title).toBe('Politique de confidentialité · RedView');
  });
});

describe('LegalLinks', () => {
  it('ouvre chaque page légale dans un nouvel onglet', () => {
    const view = renderComponent(createElement(LegalLinks));
    const links = [...view.container.querySelectorAll('a')];
    expect(links.map((link) => link.textContent)).toEqual(['Mentions légales', 'Confidentialité', 'Conditions d’utilisation', 'Accessibilité']);
    expect(links.every((link) => link.target === '_blank' && link.rel.includes('noreferrer'))).toBe(true);
    view.unmount();
  });
});
