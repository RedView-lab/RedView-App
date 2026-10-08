// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import VerificationCodeModal from './VerificationCodeModal';

/**
 * Saisie du code à 6 chiffres : chiffres seuls, envoi automatique au
 * sixième, collage, et chaque réouverture repart de cases vides, sans
 * erreur et avec un nouveau délai de renvoi.
 */

type Props = Parameters<typeof VerificationCodeModal>[0];
let view: RenderedComponent | null = null;

function element(isOpen: boolean, overrides: Partial<Props> = {}) {
  return createElement(VerificationCodeModal, {
    isOpen,
    onClose: () => {},
    onConfirm: async () => ({ success: true }),
    onResend: async () => ({ success: true }),
    ...overrides,
  });
}

const digits = () => [...view!.container.querySelectorAll<HTMLInputElement>('input')];

function type(index: number, value: string) {
  const field = digits()[index]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

describe('VerificationCodeModal', () => {
  it('ne garde que des chiffres et envoie le code au sixième', async () => {
    const onConfirm = vi.fn(async () => ({ success: true }));
    view = renderComponent(element(true, { onConfirm }));
    type(0, 'a');
    expect(digits()[0]!.value).toBe('');
    for (const [index, digit] of ['1', '2', '3', '4', '5'].entries()) type(index, digit);
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { type(5, '6'); });
    expect(onConfirm).toHaveBeenCalledWith('123456');
  });

  it('un code collé dans une case remplit les suivantes et part', async () => {
    const onConfirm = vi.fn(async () => ({ success: true }));
    view = renderComponent(element(true, { onConfirm }));
    await act(async () => { type(0, '65 43 21'); });
    expect(digits().map((field) => field.value).join('')).toBe('654321');
    expect(onConfirm).toHaveBeenCalledWith('654321');
  });

  it('chaque réouverture repart de cases vides, sans l’erreur précédente, avec un nouveau délai de renvoi', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const onConfirm = vi.fn(async () => ({ success: false, error: 'Code invalide' }));
    view = renderComponent(element(true, { onConfirm }));
    await act(async () => { type(0, '111111'); });
    expect(view.container.textContent).toContain('Code invalide');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(view.container.textContent).toContain('(20s)');

    act(() => view!.rerender(element(false, { onConfirm })));
    act(() => view!.rerender(element(true, { onConfirm })));
    expect(digits().map((field) => field.value)).toEqual(['', '', '', '', '', '']);
    expect(view.container.textContent).not.toContain('Code invalide');
    expect(view.container.textContent).toContain('(30s)');
  });
});
