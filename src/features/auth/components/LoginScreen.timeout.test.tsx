// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Connexion sur un réseau qui pend (Wi-Fi captif) : le SDK Appwrite n'a pas
 * de délai, le bouton tournait sans fin. Au bout de 20 s, le message réseau
 * s'affiche et le bouton revient.
 */

const appwrite = vi.hoisted(() => ({
  createEmailPasswordSession: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@/shared/services/appwrite', () => ({
  account: {
    deleteSession: vi.fn(async () => {}),
    createEmailPasswordSession: appwrite.createEmailPasswordSession,
    get: vi.fn(),
    createOAuth2Session: vi.fn(),
  },
  rememberAppwriteUser: vi.fn(),
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

beforeEach(() => {
  vi.useFakeTimers();
  view = renderComponent(createElement(LoginScreen));
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

describe('LoginScreen : réseau qui pend', () => {
  it('connexion sans réponse : message réseau au bout de 20 s, bouton rendu', async () => {
    const container = view!.container;
    type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'rider@example.test');
    type(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'mot-de-passe-1');
    act(() => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(appwrite.createEmailPasswordSession).toHaveBeenCalledTimes(1);
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(container.textContent).toContain("Le serveur RedView n'a pas répondu à temps");
    expect(submit.disabled).toBe(false);
  });
});
