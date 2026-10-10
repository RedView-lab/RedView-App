// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

const stripe = vi.hoisted(() => ({
  confirmPayment: vi.fn(),
  confirmSetup: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('@stripe/react-stripe-js', () => ({
  PaymentElement: () => null,
  useStripe: () => ({ confirmPayment: stripe.confirmPayment, confirmSetup: stripe.confirmSetup }),
  useElements: () => ({ submit: stripe.submit }),
}));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: () => {} }));

const { BillingActionForm } = await import('./BillingActionForm');

let view: RenderedComponent | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  stripe.submit.mockReset().mockResolvedValue({});
  stripe.confirmPayment.mockReset().mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
  stripe.confirmSetup.mockReset().mockResolvedValue({ setupIntent: { id: 'seti_1' } });
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function submitSubscription(onComplete: () => Promise<void>) {
  view = renderComponent(
    <BillingActionForm
      flow={{ mode: 'subscription', clientSecret: 'pi_secret', subscriptionId: 'sub_1', planId: 'monthly' }}
      onClose={() => {}}
      onComplete={onComplete}
    />,
  );
  const consent = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  view.click(consent);
  const form = view.container.querySelector('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('BillingActionForm (C3-1)', () => {
  it('paiement confirmé chez Stripe puis erreur réseau de l’app : réessayée, et le formulaire de paiement ne revient jamais', async () => {
    const onComplete = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await submitSubscription(onComplete);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(stripe.confirmPayment).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(3);
    expect(view!.container.querySelector('form')).toBeNull();
    expect(view!.container.textContent).toContain('Paiement reçu');
    expect(view!.container.textContent).not.toContain('Failed to fetch');

    // « Réessayer l'activation » relance la finalisation, jamais la confirmation Stripe.
    onComplete.mockResolvedValue(undefined);
    await act(async () => {
      view!.button('Réessayer l’activation').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onComplete).toHaveBeenCalledTimes(4);
    expect(stripe.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it('erreur passagère : le second essai suffit, aucun écran d’échec', async () => {
    const onComplete = vi.fn().mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValue(undefined);
    await submitSubscription(onComplete);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(view!.container.textContent).not.toContain('Réessayer l’activation');
  });

  it('refus de Stripe : rien n’est prélevé, le formulaire reste avec le message', async () => {
    stripe.confirmPayment.mockResolvedValue({ error: { message: 'Votre carte a été refusée.' } });
    const onComplete = vi.fn();
    await submitSubscription(onComplete);
    expect(onComplete).not.toHaveBeenCalled();
    expect(view!.container.querySelector('form')).not.toBeNull();
    expect(view!.container.querySelector('[role="alert"]')?.textContent).toContain('Votre carte a été refusée.');
  });
});
