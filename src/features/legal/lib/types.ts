import type { LegalPageId } from './routes';

/** Paragraphe (liens en ligne : inlineLinks.ts) ou liste à puces. */
export type LegalBlock = { p: string } | { ul: string[] };

interface LegalSection {
  heading: string;
  blocks: LegalBlock[];
}

interface LegalDocument {
  title: string;
  /** Chapeau sous le titre. */
  lead: string;
  sections: LegalSection[];
}

export type LegalDocuments = Record<LegalPageId, LegalDocument>;

/** Textes de l'interface des pages légales, dans la langue du document. */
export interface LegalChrome {
  updatedOn: string;
  backToApp: string;
  navLabel: string;
  missing: string;
  pageLabels: Record<LegalPageId, string>;
}
