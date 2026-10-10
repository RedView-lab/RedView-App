// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

import { keyboardActivatable } from './keyboardActivation';

let view: RenderedComponent | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('keyboardActivatable (C4-2, WCAG 2.1.1)', () => {
  it('focus par Tab, Entrée et Espace déclenchent le clic ; les autres touches non', () => {
    const onClick = vi.fn();
    view = renderComponent(<span {...keyboardActivatable()} onClick={onClick}>1 h 30</span>);
    const span = view.container.querySelector('span')!;
    expect(span.getAttribute('role')).toBe('button');
    expect(span.tabIndex).toBe(0);
    press(span, 'Enter');
    press(span, ' ');
    press(span, 'a');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('désactivé : ni rôle ni place dans l’ordre de tabulation', () => {
    view = renderComponent(<span {...keyboardActivatable(false)}>1 h 30</span>);
    const span = view.container.querySelector('span')!;
    expect(span.getAttribute('role')).toBeNull();
    expect(span.hasAttribute('tabindex')).toBe(false);
  });
});
