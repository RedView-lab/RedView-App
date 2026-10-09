// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Pop-in de changement d'e-mail : nouvelle adresse + mot de passe actuel,
 * puis le code reçu à la nouvelle adresse ; une erreur du serveur s'affiche
 * et laisse réessayer.
 */

const api = vi.hoisted(() => ({
  requestEmailChangeCode: vi.fn<(newEmail: string) => Promise<void>>(),
  confirmEmailChange: vi.fn<(newEmail: string, code: string, password: string) => Promise<string>>(),
}));
vi.mock('../lib/emailChange', () => api);

const { ChangeEmailDialog } = await import('./ChangeEmailDialog');

let view: RenderedComponent | null = null;
const onChanged = vi.fn();

/** Saisie dans un champ contrôlé par React (setter natif + événement `input`). */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (label: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!;

beforeEach(() => {
  api.requestEmailChangeCode.mockReset().mockResolvedValue();
  api.confirmEmailChange.mockReset().mockResolvedValue('new@example.test');
  onChanged.mockReset();
  view = renderComponent(createElement(ChangeEmailDialog, { currentEmail: 'old@example.test', anchorEl: null, onChanged, onClose: () => {} }));
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('ChangeEmailDialog', () => {
  it('adresse + mot de passe, puis code : la nouvelle adresse remonte', async () => {
    expect(button('Recevoir le code').disabled).toBe(true);
    const [email, password] = dialog().querySelectorAll<HTMLInputElement>('input');
    type(email!, 'new@example.test');
    type(password!, 'ancien-mdp');
    expect(button('Recevoir le code').disabled).toBe(false);
    act(() => button('Recevoir le code').click());
    await settle();
    expect(api.requestEmailChangeCode).toHaveBeenCalledWith('new@example.test');

    const code = dialog().querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    type(code, '12a3456');
    expect(code.value).toBe('123456');
    act(() => button('Changer l’adresse').click());
    await settle();
    expect(api.confirmEmailChange).toHaveBeenCalledWith('new@example.test', '123456', 'ancien-mdp');
    expect(onChanged).toHaveBeenCalledWith('new@example.test');
  });

  it('refus du serveur : message affiché, nouvel essai possible', async () => {
    const [email, password] = dialog().querySelectorAll<HTMLInputElement>('input');
    type(email!, 'taken@example.test');
    type(password!, 'ancien-mdp');
    api.requestEmailChangeCode.mockRejectedValueOnce(new Error('Cette adresse est déjà utilisée par un autre compte.'));
    act(() => button('Recevoir le code').click());
    await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Cette adresse est déjà utilisée par un autre compte.');
    expect(button('Recevoir le code').disabled).toBe(false);
  });
});
