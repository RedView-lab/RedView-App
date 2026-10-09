// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Inscription : la pop-in du code se ferme au moindre clic à côté. Renvoyer
 * le formulaire avec la même adresse la rouvre tant que le code vaut encore,
 * sans en redemander un (un inscrit réel avait reçu 5 fois « Veuillez
 * patienter » en 20 s) ; une autre adresse demande un nouveau code.
 */

const auth = vi.hoisted(() => ({
  sendVerificationCode: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
  verifyCodeAndCreateAccount: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
  createEmailPasswordSession: vi.fn(async () => ({})),
}));
vi.mock('./login/authRequests', () => ({
  requestPasswordRecovery: vi.fn(),
  sendVerificationCode: auth.sendVerificationCode,
  verifyCodeAndCreateAccount: auth.verifyCodeAndCreateAccount,
  resolveSignupName: (name: string, email: string) => name.trim() || email.split('@')[0] || 'User',
}));
vi.mock('@/shared/services/appwrite', () => ({
  account: {
    deleteSession: vi.fn(async () => {}),
    createOAuth2Session: vi.fn(),
    createEmailPasswordSession: auth.createEmailPasswordSession,
    get: vi.fn(async () => ({ $id: 'u1', email: 'rider@example.test', name: 'rider' })),
  },
  saveStoredAppwriteSession: vi.fn(),
}));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: vi.fn(), trackScreen: vi.fn() }));

const { default: LoginScreen } = await import('./LoginScreen');

let view: RenderedComponent | null = null;

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

const modalOpen = () => document.querySelector('.rv-modal-backdrop') !== null;

async function submitSignup(email: string) {
  const container = view!.container;
  type(container.querySelector<HTMLInputElement>('input[type="email"]')!, email);
  const passwords = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
  type(passwords[0]!, 'mot-de-passe-1');
  type(passwords[1]!, 'mot-de-passe-1');
  // happy-dom n'envoie pas le formulaire sur un clic du bouton submit.
  act(() => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const onLogin = vi.fn();

beforeEach(() => {
  auth.sendVerificationCode.mockClear();
  auth.verifyCodeAndCreateAccount.mockClear();
  auth.createEmailPasswordSession.mockReset().mockResolvedValue({});
  onLogin.mockClear();
  view = renderComponent(createElement(LoginScreen, { onLogin }));
  const signupTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === 'Sign up')!;
  act(() => signupTab.click());
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('LoginScreen : code d’inscription', () => {
  it('pop-in fermée puis formulaire renvoyé avec la même adresse : rouverte, pas de nouveau code', async () => {
    await submitSignup('rider@example.test');
    expect(auth.sendVerificationCode).toHaveBeenCalledTimes(1);
    expect(modalOpen()).toBe(true);

    act(() => document.querySelector<HTMLElement>('.rv-modal-overlay')!.click());
    expect(modalOpen()).toBe(false);

    await submitSignup('Rider@Example.test ');
    expect(auth.sendVerificationCode).toHaveBeenCalledTimes(1);
    expect(modalOpen()).toBe(true);
  });

  it('autre adresse : un nouveau code est demandé', async () => {
    await submitSignup('rider@example.test');
    act(() => document.querySelector<HTMLElement>('.rv-modal-overlay')!.click());
    await submitSignup('autre@example.test');
    expect(auth.sendVerificationCode).toHaveBeenCalledTimes(2);
  });
  it('envoi impossible (503 du serveur) : son message s’affiche, pas de pop-in, le nouvel essai redemande un code', async () => {
    auth.sendVerificationCode.mockResolvedValueOnce({
      ok: false,
      status: 503,
      data: { error: 'L’e-mail n’a pas pu être envoyé. Réessayez dans quelques minutes.' },
    } as never);
    await submitSignup('rider@example.test');
    expect(modalOpen()).toBe(false);
    expect(view!.container.textContent).toContain('L’e-mail n’a pas pu être envoyé. Réessayez dans quelques minutes.');
    await submitSignup('rider@example.test');
    expect(auth.sendVerificationCode).toHaveBeenCalledTimes(2);
    expect(modalOpen()).toBe(true);
  });
  it('compte créé mais session pas ouverte (réseau) : le nouvel essai ouvre la session sans renvoyer le code consommé', async () => {
    await submitSignup('rider@example.test');
    const digits = [...document.querySelectorAll<HTMLInputElement>('.rv-modal-card input')];
    expect(digits).toHaveLength(6);
    auth.createEmailPasswordSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    for (const [index, digit] of [...'123456'].entries()) type(digits[index]!, digit);
    await settle();
    expect(auth.verifyCodeAndCreateAccount).toHaveBeenCalledTimes(1);
    expect(onLogin).not.toHaveBeenCalled();
    expect(document.querySelector('.rv-modal-card')?.textContent).toContain('Impossible de joindre le serveur RedView');

    const verifyButton = [...document.querySelectorAll<HTMLButtonElement>('.rv-modal-card button')].find((node) => node.textContent === 'Vérifier')!;
    act(() => verifyButton.click());
    await settle();
    expect(auth.verifyCodeAndCreateAccount).toHaveBeenCalledTimes(1);
    expect(auth.createEmailPasswordSession).toHaveBeenCalledTimes(2);
    expect(onLogin).toHaveBeenCalledWith('rider@example.test');
  });
  it('consentement : les liens CGU et confidentialité annoncent le nouvel onglet aux lecteurs d’écran', () => {
    const links = [...view!.container.querySelectorAll<HTMLAnchorElement>('.rv-login-legal-consent a')];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.querySelector('.rv-sr-only')?.textContent).toBe('(nouvel onglet)');
    }
  });
});
