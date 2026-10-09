import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';

import { billingEmailFor } from '../billing/customers.js';
import { toBillingError } from '../billing/http.js';
import { BILLING_PLANS, planIdForLookupKey } from '../billing/plans.js';
import { describePriceMismatch, planIdForPrice } from '../billing/prices.js';
import { isTrialEligible, pickCurrentSubscription } from '../billing/types.js';
import { PublicError } from '../errors.js';

/**
 * Règles pures de la facturation : quel abonnement montrer, qui a droit à
 * l'essai, quels prix Stripe sont acceptés, quelles erreurs Stripe deviennent
 * des réponses publiques. Le parcours réel contre le bac à sable Stripe est
 * dans billing.sandbox.test.ts (STRIPE_SANDBOX_E2E=1).
 */

function price(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: 'price_x',
    active: true,
    currency: 'eur',
    unit_amount: 1490,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    lookup_key: 'redview_monthly',
    metadata: {},
    ...overrides,
  } as Stripe.Price;
}

describe('grille tarifaire', () => {
  it('a trois durées aux montants de la grille', () => {
    expect(BILLING_PLANS.map((plan) => [plan.id, plan.amountCents, plan.months])).toEqual([
      ['monthly', 1490, 1],
      ['semiannual', 7000, 6],
      ['annual', 11900, 12],
    ]);
    expect(planIdForLookupKey('redview_annual')).toBe('annual');
    expect(planIdForLookupKey('autre')).toBeNull();
  });

  it('refuse un prix Stripe qui ne correspond pas à la grille', () => {
    expect(describePriceMismatch('monthly', price())).toBeNull();
    expect(describePriceMismatch('monthly', price({ unit_amount: 1500 }))).toBe('amount 1500');
    expect(describePriceMismatch('monthly', price({ currency: 'usd' }))).toBe('currency usd');
    expect(describePriceMismatch('monthly', price({ active: false }))).toBe('inactive');
    expect(
      describePriceMismatch('semiannual', price({ unit_amount: 7000, recurring: { interval: 'month', interval_count: 3, usage_type: 'licensed' } as Stripe.Price.Recurring })),
    ).toBe('interval 3 month');
  });

  it('reconnaît la formule d’un ancien prix par sa métadonnée', () => {
    expect(planIdForPrice(price({ lookup_key: null, metadata: { plan_id: 'semiannual' } }))).toBe('semiannual');
    expect(planIdForPrice(price({ lookup_key: null, metadata: {} }))).toBeNull();
  });
});

describe('abonnement montré', () => {
  it('préfère un abonnement vivant à une tentative, puis l’échéance la plus lointaine', () => {
    const rows = [
      { id: 'a', status: 'incomplete', current_period_end: '2027-01-01T00:00:00Z' },
      { id: 'b', status: 'canceled', current_period_end: '2028-01-01T00:00:00Z' },
      { id: 'c', status: 'trialing', current_period_end: '2026-10-15T00:00:00Z' },
      { id: 'd', status: 'past_due', current_period_end: '2027-06-01T00:00:00Z' },
    ];
    expect(pickCurrentSubscription(rows)?.id).toBe('c');
    expect(pickCurrentSubscription(rows.filter((row) => row.id !== 'c'))?.id).toBe('d');
    expect(pickCurrentSubscription([rows[1]])).toBeNull();
  });
});

describe('essai gratuit', () => {
  it('une seule fois par client', () => {
    expect(isTrialEligible([])).toBe(true);
    expect(isTrialEligible([{ status: 'incomplete_expired', trial_start: null }])).toBe(true);
    expect(isTrialEligible([{ status: 'canceled', trial_start: 1_700_000_000 }])).toBe(false);
    // Payé sans essai puis annulé : plus d'essai non plus.
    expect(isTrialEligible([{ status: 'canceled', trial_start: null }])).toBe(false);
  });
});

describe('e-mail de facturation', () => {
  it('prend l’adresse choisie, sinon celle du compte', () => {
    expect(billingEmailFor(null, 'a@b.fr')).toBe('a@b.fr');
    expect(billingEmailFor({ stripe_customer_id: null, billing_email_mode: 'alternative', billing_email: ' f@c.fr ' }, 'a@b.fr')).toBe('f@c.fr');
    expect(billingEmailFor({ stripe_customer_id: null, billing_email_mode: 'alternative', billing_email: '' }, 'a@b.fr')).toBe('a@b.fr');
  });
});

describe('erreurs Stripe', () => {
  it('rend publiques les erreurs attendues, garde le reste interne', () => {
    const card = toBillingError({ type: 'StripeCardError', message: 'Your card was declined.' });
    expect(card).toBeInstanceOf(PublicError);
    expect((card as PublicError).status).toBe(402);
    const missing = toBillingError({ type: 'StripeInvalidRequestError', code: 'resource_missing', message: 'No such setupintent: seti_x' });
    expect((missing as PublicError).message).toBe('Billing object not found.');
    const internal = new Error('boom');
    expect(toBillingError(internal)).toBe(internal);
  });

  it('Stripe injoignable, en panne ou qui limite : 503 « réessayez », pas une erreur interne', () => {
    for (const type of ['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError']) {
      const error = toBillingError({ type, message: 'An error occurred with our connection to Stripe.' });
      expect(error).toBeInstanceOf(PublicError);
      expect((error as PublicError).status).toBe(503);
    }
  });
});
