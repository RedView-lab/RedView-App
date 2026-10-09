import { describe, it, expect } from 'vitest';

import { PRODUCTION_ENV, missingProductionEnv } from '../env-check.mjs';

const complete = Object.fromEntries(PRODUCTION_ENV.map(({ name }) => [name, 'set']));

describe('missingProductionEnv', () => {
  it('reports nothing when every production variable is set', () => {
    expect(missingProductionEnv(complete)).toEqual([]);
  });

  it('reports a missing or blank variable with the feature it disables', () => {
    const missing = missingProductionEnv({ ...complete, RESEND_API_KEY: undefined, STRIPE_WEBHOOK_SECRET: '  ' });
    expect(missing.map(({ name }) => name)).toEqual(['RESEND_API_KEY', 'STRIPE_WEBHOOK_SECRET']);
    expect(missing[0].feature).toMatch(/e-mails/);
  });

  it('checks the variables the e-mail, billing and routing code read', () => {
    const names = PRODUCTION_ENV.map(({ name }) => name);
    for (const required of ['APPWRITE_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'BROUTER_UPSTREAM']) {
      expect(names).toContain(required);
    }
  });
});
