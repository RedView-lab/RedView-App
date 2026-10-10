import { describe, expect, it } from 'vitest';

import { apiRateBucket } from '../api-rate-buckets.mjs';

const route = (name: string) => ({ route: name, isAuth: name.startsWith('auth/') });

describe('apiRateBucket', () => {
  it('routage (BRouter, POI) : un seau à part, plus le quota général partagé (A4-1)', () => {
    expect(apiRateBucket(route('brouter'), 'GET')).toEqual(['routing', 300]);
    expect(apiRateBucket(route('poi'), 'POST')).toEqual(['routing', 300]);
    expect(apiRateBucket(route('geocode-iconic'), 'GET')).toEqual(['general', 120]);
  });

  it('garde les seaux existants', () => {
    expect(apiRateBucket(route('auth/forgot-password'), 'POST')).toEqual(['auth', 15]);
    expect(apiRateBucket(route('weather'), 'GET')[0]).toBe('weather');
    expect(apiRateBucket(route('pointcloud'), 'GET')[0]).toBe('pointcloud');
    expect(apiRateBucket(route('billing/subscription'), 'POST')[0]).toBe('billing');
    expect(apiRateBucket(route('billing/overview'), 'GET')[0]).toBe('general');
    expect(apiRateBucket(route('stripe/webhook'), 'POST')[0]).toBe('stripe-webhook');
    expect(apiRateBucket(route('snow-context'), 'GET')[0]).toBe('snow');
    expect(apiRateBucket(route('meteofrance'), 'GET')[0]).toBe('snow');
    expect(apiRateBucket(null, 'GET')).toEqual(['general', 120]);
  });
});
