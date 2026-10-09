// @vitest-environment happy-dom
import axe from 'axe-core';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

/**
 * Accessibilité (axe, WCAG A/AA comme e2e:journey) des formulaires du compte
 * que le parcours n'ouvre pas : pop-in de changement d'e-mail (ses deux
 * étapes), mot de passe à trois champs, coordonnées. Le contraste n'est pas
 * calculable sans mise en page : il reste à la charge du parcours.
 */

vi.mock('../lib/emailChange', () => ({
  requestEmailChangeCode: vi.fn(async () => {}),
  confirmEmailChange: vi.fn(async () => 'new@example.test'),
}));

const { ChangeEmailDialog } = await import('./ChangeEmailDialog');
const { AccountPasswordForm } = await import('./AccountPasswordForm');
const { AccountIdentityForm } = await import('./AccountIdentityForm');

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

async function violations(root: Element): Promise<string[]> {
  const result = await axe.run(root, {
    runOnly: { type: 'tag', values: WCAG_TAGS },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

let view: RenderedComponent | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

describe('accessibilité des formulaires du compte', () => {
  it('témoin : axe détecte bien un défaut sous happy-dom', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<input type="text"><button type="button"></button>';
    document.body.appendChild(root);
    const found = await violations(root);
    root.remove();
    expect(found.some((line) => line.startsWith('label:'))).toBe(true);
    expect(found.some((line) => line.startsWith('button-name:'))).toBe(true);
  });

  it('pop-in de changement d’e-mail : étape adresse puis étape code', async () => {
    view = renderComponent(createElement(ChangeEmailDialog, { currentEmail: 'old@example.test', anchorEl: null, onChanged: () => {}, onClose: () => {} }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(await violations(dialog)).toEqual([]);

    const [email, password] = dialog.querySelectorAll<HTMLInputElement>('input');
    type(email!, 'new@example.test');
    type(password!, 'ancien-mdp');
    const submit = [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Recevoir le code')!;
    await act(async () => {
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull();
    expect(await violations(dialog)).toEqual([]);
  });

  it('mot de passe (avec ou sans mot de passe actuel) et coordonnées', async () => {
    for (const hasPassword of [true, false]) {
      view?.unmount();
      view = renderComponent(createElement(AccountPasswordForm, {
        value: { current: '', next: 'nouveau-1', confirm: 'nouveau-2' },
        hasPassword,
        isSaving: false,
        onChange: () => {},
        onSave: () => {},
      }));
      expect(await violations(view.container)).toEqual([]);
    }
    view?.unmount();
    const identity = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' };
    view = renderComponent(createElement(AccountIdentityForm, {
      value: identity,
      initialValue: identity,
      isSaving: false,
      hasPassword: true,
      onChange: () => {},
      onCancel: () => {},
      onSave: () => {},
      onEmailChanged: () => {},
    }));
    expect(await violations(view.container)).toEqual([]);
  });
});
