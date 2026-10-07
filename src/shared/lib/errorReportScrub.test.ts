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
