import { useEffect, useMemo, type ReactNode } from 'react';

import { NewTabHint } from '@/shared/components/NewTabHint';
import { RedViewLogo } from '@/shared/components/RedViewLogo';
import { useAppI18n } from '@/shared/i18n';
import { ENGLISH_CHROME, englishLegalDocuments } from '../content/en';
import { FRENCH_CHROME, frenchLegalDocuments } from '../content/fr';
import { parseInlineLinks } from '../lib/inlineLinks';
import { LEGAL_PUBLISHER, LEGAL_UPDATED_ON } from '../lib/publisher';
import { LEGAL_PAGES, type LegalPageId } from '../lib/routes';
import type { LegalBlock } from '../lib/types';
import '../styles/legal.css';

function InlineText({ source }: { source: string }) {
  return (
    <>
      {parseInlineLinks(source).map((segment, index) =>
        'href' in segment ? (
          segment.href.startsWith('https:') ? (
            <a key={index} href={segment.href} target="_blank" rel="noreferrer">
              {segment.text}
              <NewTabHint />
            </a>
          ) : (
            <a key={index} href={segment.href}>
              {segment.text}
            </a>
          )
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: LegalBlock }): ReactNode {
  if ('ul' in block) {
    return (
      <ul>
        {block.ul.map((item, index) => (
          <li key={index}>
            <InlineText source={item} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p>
      <InlineText source={block.p} />
    </p>
  );
}

function formatUpdatedOn(iso: string, locale: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'long' });
}

/**
 * Page légale publique (mentions, confidentialité, CGU, accessibilité),
 * rendue par App.tsx sans session. Les textes ont leur propre version
 * française et anglaise (content/) : le traducteur du DOM n'y touche pas.
 */
export function LegalPage({ page }: { page: LegalPageId }) {
  const { locale } = useAppI18n();
  const isFrench = locale === 'fr';
  const chrome = isFrench ? FRENCH_CHROME : ENGLISH_CHROME;
  const documents = useMemo(
    () => (isFrench ? frenchLegalDocuments(LEGAL_PUBLISHER) : englishLegalDocuments(LEGAL_PUBLISHER)),
    [isFrench],
  );
  const document_ = documents[page];

  useEffect(() => {
    const previous = document.title;
    document.title = `${document_.title} · RedView`;
    return () => {
      document.title = previous;
    };
  }, [document_.title]);

  return (
    <div className="rv-legal" data-rv-no-translate="true" lang={isFrench ? 'fr' : 'en'}>
      <header className="rv-legal__header">
        <a className="rv-legal__brand" href="/" aria-label={chrome.backToApp}>
          <RedViewLogo />
        </a>
        <nav className="rv-legal__nav" aria-label={chrome.navLabel}>
          {LEGAL_PAGES.map((entry) => (
            <a key={entry.id} href={entry.path} aria-current={entry.id === page ? 'page' : undefined}>
              {chrome.pageLabels[entry.id]}
            </a>
          ))}
        </nav>
      </header>
      <main className="rv-legal__main">
        <article className="rv-legal__document">
          <h1>{document_.title}</h1>
          <p className="rv-legal__updated">{chrome.updatedOn.replace('{{date}}', formatUpdatedOn(LEGAL_UPDATED_ON, locale))}</p>
          <p className="rv-legal__lead">
            <InlineText source={document_.lead} />
          </p>
          {document_.sections.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.blocks.map((block, index) => (
                <Block key={index} block={block} />
              ))}
            </section>
          ))}
        </article>
        <a className="rv-legal__back" href="/">
          {chrome.backToApp}
        </a>
      </main>
    </div>
  );
}
