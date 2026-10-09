import { describe, expect, it } from 'vitest';

import { englishLegalDocuments } from './content/en';
import { frenchLegalDocuments } from './content/fr';
import { parseInlineLinks } from './lib/inlineLinks';
import { LEGAL_PUBLISHER, type LegalPublisher } from './lib/publisher';
import { LEGAL_PAGES, legalPagePath, resolveLegalPage } from './lib/routes';

describe('routes des pages légales', () => {
  it('reconnaît chaque page, barre finale tolérée, et rien d’autre', () => {
    expect(resolveLegalPage('/mentions-legales')).toBe('legal-notice');
    expect(resolveLegalPage('/confidentialite/')).toBe('privacy');
    expect(resolveLegalPage('/cgu')).toBe('terms');
    expect(resolveLegalPage('/accessibilite')).toBe('accessibility');
    for (const path of ['/', '/project/x--1', '/cgu/extra', '/CGU']) expect(resolveLegalPage(path)).toBeNull();
    expect(legalPagePath('privacy')).toBe('/confidentialite');
  });
});

describe('liens dans le texte', () => {
  it('rend les liens https, mailto et internes', () => {
    expect(parseInlineLinks('Voir [la CNIL](https://www.cnil.fr) ou [nous](mailto:contact@example.com) et [les CGU](/cgu).')).toEqual([
      { text: 'Voir ' },
      { text: 'la CNIL', href: 'https://www.cnil.fr' },
      { text: ' ou ' },
      { text: 'nous', href: 'mailto:contact@example.com' },
      { text: ' et ' },
      { text: 'les CGU', href: '/cgu' },
      { text: '.' },
    ]);
  });

  it('laisse en texte toute autre cible (javascript:, http:, données)', () => {
    for (const href of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', '//evil.example']) {
      const source = `[clic](${href})`;
      const segments = parseInlineLinks(source);
      expect(segments.some((segment) => 'href' in segment), href).toBe(false);
      expect(segments.map((segment) => segment.text).join('')).toBe(source);
    }
  });
});

const COMPLETE_PUBLISHER: LegalPublisher = {
  name: 'RedView SAS',
  legalForm: 'SAS au capital de 1 000 €',
  registration: 'RCS Annecy 123 456 789',
  vatNumber: 'FR00123456789',
  address: '1 rue de l’Exemple, 74000 Annecy',
  phone: '+33 4 00 00 00 00',
  publicationDirector: 'Prénom Nom, président',
  contactEmail: 'contact@example.com',
  host: { name: 'Oracle', address: 'Adresse', phone: '+33 1 00 00 00 00', region: 'Paris (France)' },
  consumerMediator: 'Médiateur, https://example.com',
};

describe('textes des pages légales', () => {
  it('ont la même structure en français et en anglais, page par page', () => {
    const fr = frenchLegalDocuments(LEGAL_PUBLISHER);
    const en = englishLegalDocuments(LEGAL_PUBLISHER);
    for (const { id } of LEGAL_PAGES) {
      const shape = (doc: typeof fr[typeof id]) => doc.sections.map((section) => section.blocks.map((block) => ('ul' in block ? `ul${block.ul.length}` : 'p')).join(','));
      expect(shape(en[id]), id).toEqual(shape(fr[id]));
    }
  });

  it('signalent chaque information d’identité manquante, et aucune une fois l’éditeur renseigné', () => {
    const missingFr = JSON.stringify(frenchLegalDocuments({ ...COMPLETE_PUBLISHER, name: null }));
    expect(missingFr).toContain('[à compléter]');
    for (const docs of [frenchLegalDocuments(COMPLETE_PUBLISHER), englishLegalDocuments(COMPLETE_PUBLISHER)]) {
      const text = JSON.stringify(docs);
      expect(text).not.toContain('[à compléter]');
      expect(text).not.toContain('[to be completed]');
      expect(text).toContain('[contact@example.com](mailto:contact@example.com)');
    }
  });

  it('ne contiennent que des liens sûrs', () => {
    for (const docs of [frenchLegalDocuments(COMPLETE_PUBLISHER), englishLegalDocuments(COMPLETE_PUBLISHER)]) {
      for (const doc of Object.values(docs)) {
        const texts = [doc.lead, ...doc.sections.flatMap((section) => section.blocks.flatMap((block) => ('ul' in block ? block.ul : [block.p])))];
        for (const text of texts) {
          // Aucun lien laissé en texte brut par le filtre de sécurité.
          for (const segment of parseInlineLinks(text)) expect(segment.text).not.toMatch(/\]\(/);
        }
      }
    }
  });
});
