/**
 * Identité de l'éditeur et de l'hébergeur, reprise par toutes les pages
 * légales (mentions légales LCEN art. 1-1, politique de confidentialité, CGU).
 * Une seule source : remplir ces champs suffit à compléter les quatre pages.
 * Un champ `null` s'affiche « [à compléter] » : à renseigner avant toute mise
 * en production (docs/audits/2026-10-08-conformite-fr-ue.md, § 7 et § 8).
 *
 * L'adresse de contact est aussi celle des e-mails de service
 * (SUPPORT_EMAIL côté serveur, .env.example) : garder les deux identiques.
 */
export interface LegalPublisher {
  /** Raison sociale, ou nom et prénom pour une entreprise individuelle. */
  name: string | null;
  /** Forme juridique et capital, p. ex. « SAS au capital de 1 000 € ». */
  legalForm: string | null;
  /** Immatriculation, p. ex. « RCS Annecy 123 456 789 » ou « SIREN 123 456 789 ». */
  registration: string | null;
  vatNumber: string | null;
  address: string | null;
  phone: string | null;
  publicationDirector: string | null;
  /** Contact unique : questions, exercice des droits RGPD, signalements (DSA). */
  contactEmail: string | null;
  /** Hébergeur (VPS Oracle Cloud Infrastructure) : entité contractante et région à confirmer. */
  host: {
    name: string | null;
    address: string | null;
    phone: string | null;
    /** Région OCI des serveurs, p. ex. « Paris (France) ». */
    region: string | null;
  };
  /** Médiateur de la consommation (art. L.612-1 C. conso) : nom et site. */
  consumerMediator: string | null;
}

export const LEGAL_PUBLISHER: LegalPublisher = {
  name: 'Victor Bouscavet',
  legalForm: null,
  registration: null,
  vatNumber: null,
  address: null,
  phone: null,
  publicationDirector: 'Victor Bouscavet, CEO',
  contactEmail: 'redview.app@proton.me',
  host: {
    name: null,
    address: null,
    phone: null,
    region: null,
  },
  consumerMediator: null,
};

/** Date de la dernière mise à jour des textes (ISO), affichée en tête de chaque page. */
export const LEGAL_UPDATED_ON = '2026-10-09';
