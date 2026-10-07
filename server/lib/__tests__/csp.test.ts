import { describe, expect, it } from 'vitest';
import { CSP_REPORT_URI, REDVIEW_CSP_HEADER, buildCspHeader } from '../csp.mjs';

function directives(header: string): Map<string, string[]> {
  return new Map(header.split('; ').map((directive) => {
    const [name, ...values] = directive.split(' ');
    return [name!, values];
  }));
}

describe('Content-Security-Policy', () => {
  const policy = directives(REDVIEW_CSP_HEADER);

  it('runs WebAssembly without allowing JavaScript eval or inline scripts', () => {
    const scripts = policy.get('script-src')!;
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
  });

  it('keeps blob: workers (Mapbox GL) and blocks plugins, framing and foreign forms', () => {
    expect(policy.get('worker-src')).toContain('blob:');
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
  });

  it('reports violations to GlitchTip in production only', () => {
    expect(policy.get('report-uri')).toEqual([CSP_REPORT_URI]);
    expect(policy.has('upgrade-insecure-requests')).toBe(true);
    const local = directives(buildCspHeader({ reportUri: null, upgradeInsecureRequests: false }));
    expect(local.has('report-uri')).toBe(false);
    expect(local.has('upgrade-insecure-requests')).toBe(false);
    expect(local.get('script-src')).toEqual(policy.get('script-src'));
  });
});
