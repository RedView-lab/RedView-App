// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Connexion : la session est créée directement. Une session encore active
 * (refus `user_session_already_exists`) est fermée puis la création réessayée ;
 * jamais de fermeture à l'aveugle avant, qui répondait 401 à chaque connexion
 * (aucune session sur cet écran), en rouge dans la console.
 */

const appwrite = vi.hoisted(() => ({
  deleteSession: vi.fn(async () => ({})),
  createEmailPasswordSession: vi.fn(async () => ({})),
}));
vi.mock('@/shared/services/appwrite', () => ({
  account: {
    deleteSession: appwrite.deleteSession,
    createEmailPasswordSession: appwrite.createEmailPasswordSession,
    createOAuth2Session: vi.fn(),
    get: vi.fn(async () => ({ $id: 'u1', email: 'rider@example.test', name: 'rider' })),
  },
  saveStoredAppwriteSession: vi.fn(),
}));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: vi.fn(), trackScreen: vi.fn() }));

const { default: LoginScreen } = await import('./LoginScreen');

let view: RenderedComponent | null = null;
const onLogin = vi.fn();

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitLogin() {
  const container = view!.container;
  type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'rider@example.test');
  type(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'mot-de-passe-1');
  act(() => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const appwriteError = (type: string) => Object.assign(new Error(type), { code: 401, type });

beforeEach(() => {
  appwrite.deleteSession.mockClear();
  appwrite.createEmailPasswordSession.mockReset().mockResolvedValue({});
  onLogin.mockClear();
  view = renderComponent(createElement(LoginScreen, { onLogin }));
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('LoginScreen : ouverture de session', () => {
  it('sans session active : connexion directe, aucune fermeture de session', async () => {
    await submitLogin();
    expect(appwrite.createEmailPasswordSession).toHaveBeenCalledTimes(1);
    expect(appwrite.deleteSession).not.toHaveBeenCalled();
    expect(onLogin).toHaveBeenCalledWith('rider@example.test');
  });

  it('session encore active : fermée, puis connexion réessayée', async () => {
    appwrite.createEmailPasswordSession.mockRejectedValueOnce(appwriteError('user_session_already_exists'));
    await submitLogin();
    expect(appwrite.deleteSession).toHaveBeenCalledWith('current');
    expect(appwrite.createEmailPasswordSession).toHaveBeenCalledTimes(2);
    expect(onLogin).toHaveBeenCalledWith('rider@example.test');
  });

  it('mauvais mot de passe : erreur affichée, aucune fermeture de session', async () => {
    appwrite.createEmailPasswordSession.mockRejectedValueOnce(appwriteError('user_invalid_credentials'));
    await submitLogin();
    expect(appwrite.deleteSession).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
    expect(view!.container.textContent).toContain('Adresse e-mail ou mot de passe incorrect.');
  });
});
