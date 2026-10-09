import { describe, expect, it } from 'vitest';

import { ApiNetworkError } from '@/shared/lib/apiFetch';

import { authFailureReason, resolveOAuthCompletion } from './authAnalytics';

const NOW = Date.UTC(2026, 9, 7, 12);
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;
const iso = (time: number) => new Date(time).toISOString();

describe('retour OAuth', () => {
  it('compte créé à l’instant → inscription ; compte ancien → connexion', () => {
    const intent = { method: 'google' as const, at: minutesAgo(2) };
    expect(resolveOAuthCompletion(intent, iso(minutesAgo(1)), NOW)).toEqual({ name: 'signup_completed', method: 'google' });
    expect(resolveOAuthCompletion(intent, iso(minutesAgo(60 * 24 * 40)), NOW)).toEqual({ name: 'login_completed', method: 'google' });
  });

  it('sans intention, intention périmée ou date illisible', () => {
    expect(resolveOAuthCompletion(null, iso(minutesAgo(1)), NOW)).toBeNull();
    expect(resolveOAuthCompletion({ method: 'google', at: minutesAgo(31) }, iso(minutesAgo(1)), NOW)).toBeNull();
    expect(resolveOAuthCompletion({ method: 'google', at: minutesAgo(1) }, 'pas une date', NOW)).toEqual({ name: 'login_completed', method: 'google' });
  });
});

describe('authFailureReason', () => {
  it('panne réseau, délai dépassé ou erreur HTTP', () => {
    expect(authFailureReason(new TypeError('Failed to fetch'))).toBe('network');
    expect(authFailureReason(new ApiNetworkError(true))).toBe('network');
    expect(authFailureReason(new ApiNetworkError(false))).toBe('network');
    expect(authFailureReason({ code: 401 })).toBe('credentials');
    expect(authFailureReason({ code: 429 })).toBe('rate_limited');
    expect(authFailureReason(new Error('x'))).toBe('other');
  });
});
