import { describe, expect, it } from 'vitest';

import { classifyBrouterError } from './brouterErrorMessage';

describe('classifyBrouterError', () => {
  it('range chaque message BRouter dans une catégorie, sans le message', () => {
    expect(classifyBrouterError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limited');
    expect(classifyBrouterError(new Error('via-position in restricted area'))).toBe('restricted');
    expect(classifyBrouterError(new Error('from-position not mapped in existing datafile'))).toBe('not_mapped');
    expect(classifyBrouterError('target not reachable')).toBe('no_route');
    expect(classifyBrouterError(new Error('operation killed by thread-priority-watchdog'))).toBe('timeout');
    expect(classifyBrouterError(new Error('Itinéraire hors zone autorisée.'))).toBe('out_of_zone');
    expect(classifyBrouterError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyBrouterError({ detail: 'HTTP 504 upstream unreachable' })).toBe('network');
    expect(classifyBrouterError(new Error('quelque chose d’autre'))).toBe('other');
    expect(classifyBrouterError(null)).toBe('other');
  });
});
