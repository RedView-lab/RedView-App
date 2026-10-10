// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

import type { SubscriptionSnapshot, SubscriptionState } from '../../types';
import { SubscriptionPanel } from './SubscriptionPanel';

function state(snapshot: SubscriptionSnapshot | null, trialEligible = true): SubscriptionState {
  return { isLoading: false, error: null, snapshot, trialEligible };
}

const NONE: SubscriptionSnapshot = {
  subscriptionId: null,
  isSubscribed: false,
  status: 'none',
  planId: null,
  priceId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

const TRIALING: SubscriptionSnapshot = {
  subscriptionId: 'sub_123',
  isSubscribed: true,
  status: 'trialing',
  planId: 'semiannual',
  priceId: 'price_6',
  currentPeriodEnd: '2026-10-15T10:00:00.000Z',
  cancelAtPeriodEnd: false,
};

let view: RenderedComponent | null = null;

function render(subscriptionState: SubscriptionState, handlers: Partial<Parameters<typeof SubscriptionPanel>[0]> = {}) {
  view = renderComponent(
    createElement(SubscriptionPanel, {
      subscriptionState,
      contactPreference: { mode: 'account', alternativeEmail: '' },
      setContactPreference: () => {},
      accountEmail: 'rider@example.com',
      paymentMethods: [],
      billingActionBusy: false,
      billingActionError: null,
      contactStatusMessage: null,
      onChoosePlan: () => {},
      onSwitchPlan: () => {},
      onCancelSubscription: async () => true,
      onResumeSubscription: () => {},
      onOpenPortal: () => {},
      onManagePaymentMethod: () => {},
      onSetDefaultPaymentMethod: () => {},
      ...handlers,
    }),
  );
  return view;
}

afterEach(() => {
  view?.unmount();
  view = null;
});

const text = (element: Element) => (element.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ');

describe('onglet Abonnement', () => {
  it('montre la grille 1 mois / 6 mois / 1 an avec l’essai et souscrit à la durée choisie', () => {
    const onChoosePlan = vi.fn();
    const { container, click } = render(state(NONE), { onChoosePlan });
    const cards = [...container.querySelectorAll('.rvpb-plan-card')];
    expect(cards).toHaveLength(3);
    expect(text(cards[0])).toContain('14,90');
    expect(text(cards[0])).toContain('Sans engagement');
    expect(text(cards[1])).toContain('-22%');
    expect(text(cards[1])).toContain('Soit 11,67 € par mois');
    expect(text(cards[2])).toContain('-33%');
    expect(text(cards[2])).toContain('Soit 9,92 € par mois');
    expect(container.querySelectorAll('.rvpb-plan-card__pill')).toHaveLength(3);
    expect(text(cards[0])).toContain('7 jours d’essai gratuit inclus');

    click(cards[1].querySelector('.rvpb-plan-card__cta')!);
    expect(onChoosePlan).toHaveBeenCalledWith('semiannual');
    // Pas d'abonnement : ni résiliation ni moyens de paiement.
    expect(container.textContent).not.toContain('Résilier votre contrat');
    expect(container.textContent).not.toContain('Informations de paiement');
  });

  it('ne promet pas d’essai quand il a déjà été utilisé', () => {
    const { container } = render(state(NONE, false));
    expect(container.querySelectorAll('.rvpb-plan-card__pill')).toHaveLength(0);
    expect(container.textContent).toContain('prélevés à la souscription');
  });

  it('en essai : formule en cours, autres durées par le portail, résiliation directe', async () => {
    const onSwitchPlan = vi.fn();
    const onCancelSubscription = vi.fn(async () => true);
    const { container, click, button } = render(state(TRIALING, false), { onSwitchPlan, onCancelSubscription });
    const cards = [...container.querySelectorAll('.rvpb-plan-card')];
    expect(cards[1].classList.contains('is-current')).toBe(true);
    expect(text(cards[1])).toContain('Essai en cours');
    expect((cards[1].querySelector('.rvpb-plan-card__cta') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Essai gratuit jusqu’au 15 octobre 2026');

    click(cards[2].querySelector('.rvpb-plan-card__cta')!);
    expect(onSwitchPlan).toHaveBeenCalledWith('annual');

    // « Résilier votre contrat » : récapitulatif (contrat, date de fin), puis confirmation.
    click(button('Résilier votre contrat'));
    const dialog = document.body.querySelector('[role="dialog"][aria-labelledby="rvpb-cancel-subscription-title"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('sub_123');
    expect(dialog.textContent).toContain('rider@example.com');
    expect(dialog.textContent).toContain('15 octobre 2026');
    click([...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Confirmer la résiliation')!);
    expect(onCancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('résilié : propose la reprise, plus le changement de durée', () => {
    const onResumeSubscription = vi.fn();
    const { container, click, button } = render(state({ ...TRIALING, status: 'active', cancelAtPeriodEnd: true }, false), { onResumeSubscription });
    expect(container.textContent).toContain('Résilié : votre abonnement prend fin le 15 octobre 2026');
    expect(container.textContent).not.toContain('Résilier votre contrat');
    const otherCard = container.querySelectorAll('.rvpb-plan-card')[0];
    expect((otherCard.querySelector('.rvpb-plan-card__cta') as HTMLButtonElement).disabled).toBe(true);
    click(button('Reprendre mon abonnement'));
    expect(onResumeSubscription).toHaveBeenCalledTimes(1);
  });

  it('incident de paiement : la bulle dit de mettre à jour le moyen de paiement, pas de « reprendre » (C3-2)', () => {
    const { container } = render(state({ ...TRIALING, status: 'past_due' }, false));
    const otherCta = container.querySelectorAll('.rvpb-plan-card')[0].querySelector('.rvpb-plan-card__cta') as HTMLButtonElement;
    expect(otherCta.disabled).toBe(true);
    expect(otherCta.closest('[title]')?.getAttribute('title') ?? otherCta.title).toBe('Mettez d’abord à jour votre moyen de paiement pour changer de formule.');
  });

  it('pop-in de résiliation : Tab et Maj+Tab restent dedans (C3-3)', async () => {
    const { click, button } = render(state(TRIALING, false));
    click(button('Résilier votre contrat'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="rvpb-cancel-subscription-title"]')!;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    const last = buttons[buttons.length - 1];
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });
});
