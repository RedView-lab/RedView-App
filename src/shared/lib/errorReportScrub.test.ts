import { describe, it, expect } from 'vitest';
import { scrubBreadcrumb, scrubErrorEvent, stripUrlSecrets } from './errorReportScrub';

describe('stripUrlSecrets', () => {
  it('keeps origin and path, drops query and fragment', () => {
    expect(stripUrlSecrets('https://app.redview.tech/?userId=u1&secret=s3cr3t&email=a%40b.c')).toBe('https://app.redview.tech/');
    expect(stripUrlSecrets('/api/openmeteo/v1/forecast?latitude=45.9&longitude=6.8')).toBe('/api/openmeteo/v1/forecast');
    expect(stripUrlSecrets('/project/col--abc#comment-12')).toBe('/project/col--abc');
    expect(stripUrlSecrets('/viewer')).toBe('/viewer');
    expect(stripUrlSecrets(undefined)).toBeUndefined();
  });
});

describe('scrubErrorEvent', () => {
  it('reduces the page URL to its path and drops query string, headers and cookies', () => {
    const event = scrubErrorEvent({
      request: {
        url: 'https://app.redview.tech/?userId=u1&secret=s3cr3t',
        query_string: 'userId=u1&secret=s3cr3t',
        headers: { Referer: 'https://app.redview.tech/?userId=u1&secret=s3cr3t', 'User-Agent': 'x' },
        cookies: 'a=b',
      },
    });
    expect(event.request).toEqual({ url: 'https://app.redview.tech/' });
  });

  it('scrubs the navigation breadcrumb left by the reset link and fetch URLs', () => {
    const event = scrubErrorEvent({
      breadcrumbs: [
        { category: 'navigation', data: { from: '/?userId=u1&secret=s3cr3t', to: '/' } },
        { category: 'fetch', data: { method: 'GET', url: '/api/poi?op=bbox&south=45&north=46', status_code: 200 } },
        { category: 'ui.click', data: undefined },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: 'navigation', data: { from: '/', to: '/' } },
      { category: 'fetch', data: { method: 'GET', url: '/api/poi', status_code: 200 } },
      { category: 'ui.click', data: undefined },
    ]);
  });

  it('returns the same breadcrumb object when nothing needs scrubbing', () => {
    const crumb = { category: 'fetch', data: { url: '/api/health' } };
    expect(scrubBreadcrumb(crumb)).toBe(crumb);
  });
});

// G1-1 (audit du 2026-10-10) : les journaux de console portent des noms choisis
// par l'utilisateur (fichiers .fit — souvent la date et le titre de la sortie —,
// fichiers .redview, projets), interpolés ou passés en arguments, et le message
// d'une erreur JSON cite un extrait du document. Rien de cela ne part.
describe('scrubBreadcrumb — console (G1-1)', () => {
  it('ne garde que l’étiquette du module, ni le texte ni les arguments', () => {
    const crumb = scrubBreadcrumb({
      category: 'console',
      level: 'warning',
      message: '[fitFiles] upload failed for file 2026-09-14 Ventoux avec Julie.fit Error: quota',
      data: { arguments: ['[fitFiles] upload failed for file', '2026-09-14 Ventoux avec Julie.fit', { message: 'quota' }], logger: 'console' },
    });
    expect(crumb).toEqual({ category: 'console', level: 'warning', message: '[fitFiles]', data: { logger: 'console' } });
  });

  it('message interpolé : le nom ne survit pas', () => {
    const crumb = scrubBreadcrumb({
      category: 'console',
      message: '[ProjectBrowser] Sortie Ventoux avec Julie.redview: 2 unreadable FIT file(s) skipped',
      data: { arguments: ['[ProjectBrowser] Sortie Ventoux avec Julie.redview: 2 unreadable FIT file(s) skipped'] },
    });
    expect(JSON.stringify(crumb)).not.toMatch(/Julie|Ventoux/);
    expect(crumb.message).toBe('[ProjectBrowser]');
  });

  it('sans étiquette : un texte neutre', () => {
    const crumb = scrubBreadcrumb({ category: 'console', message: 'SyntaxError: Unexpected token \'S\', "Sortie Ven"... is not valid JSON' });
    expect(crumb.message).toBe('[console]');
  });
});

describe('scrubBreadcrumb — clics (G1-1)', () => {
  it('les valeurs d’attributs du sélecteur (aria-label, title…) sont retirées', () => {
    const crumb = scrubBreadcrumb({
      category: 'ui.click',
      message: 'div.rv-project-card > button.rv-project-card__open[aria-label="Ouvrir Sortie Ventoux avec Julie"]',
    });
    expect(crumb.message).toBe('div.rv-project-card > button.rv-project-card__open[aria-label]');
  });
});

describe('scrubErrorEvent — extraits de document (G1-1)', () => {
  it('le message d’une erreur JSON ne cite plus le document', () => {
    const event = scrubErrorEvent({
      exception: {
        values: [
          { type: 'SyntaxError', value: 'Unexpected token \'S\', "Sortie Ven"... is not valid JSON' },
          { type: 'SyntaxError', value: 'JSON Parse error: Unexpected identifier "Julie"' },
          { type: 'SyntaxError', value: 'Expected \',\' or \'}\' after property value in JSON at position 74 (line 1 column 75)' },
          { type: 'TypeError', value: 'Cannot read properties of undefined (reading \'name\')' },
        ],
      },
    });
    const values = event.exception!.values!.map((value) => value.value);
    expect(values[0]).toBe('Unexpected token, "…"... is not valid JSON');
    expect(values[1]).toBe('JSON Parse error: Unexpected identifier "…"');
    expect(values[2]).toBe('Expected \',\' or \'}\' after property value in JSON at position 74 (line 1 column 75)');
    // Hors JSON, le message reste tel quel.
    expect(values[3]).toBe('Cannot read properties of undefined (reading \'name\')');
  });
});
