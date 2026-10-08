import { describe, expect, it } from 'vitest';

import { BILLING_PLANS, TRIAL_DAYS as SERVER_TRIAL_DAYS } from '../../../../../api/_lib/billing/plans';
import {
  DISPLAY_PLANS,
  TRIAL_DAYS,
  discountPercent,
  formatEuroAmount,
  formatEuros,
  getDisplayPlan,
  monthlyEquivalentCents,
} from './plans';

describe('grille tarifaire affichée', () => {
  it('est identique à la référence du serveur (montants, durées, essai)', () => {
    expect(DISPLAY_PLANS.map(({ id, amountCents, months }) => ({ id, amountCents, months }))).toEqual(
      BILLING_PLANS.map(({ id, amountCents, months }) => ({ id, amountCents, months })),
    );
    expect(TRIAL_DAYS).toBe(SERVER_TRIAL_DAYS);
  });

  it('donne les réductions et prix mensuels de la grille', () => {
    expect(discountPercent(getDisplayPlan('monthly'))).toBe(0);
    expect(discountPercent(getDisplayPlan('semiannual'))).toBe(22);
    expect(discountPercent(getDisplayPlan('annual'))).toBe(33);
    expect(monthlyEquivalentCents(getDisplayPlan('semiannual'))).toBe(1167);
    expect(monthlyEquivalentCents(getDisplayPlan('annual'))).toBe(992);
  });

  it('formate les montants à la française, sans décimales inutiles', () => {
    const nbsp = /[\u00a0\u202f]/g;
    expect(formatEuros(1490).replace(nbsp, ' ')).toBe('14,90 €');
    expect(formatEuros(7000).replace(nbsp, ' ')).toBe('70 €');
    expect(formatEuroAmount(11900)).toBe('119');
    expect(formatEuroAmount(992)).toBe('9,92');
  });
});
