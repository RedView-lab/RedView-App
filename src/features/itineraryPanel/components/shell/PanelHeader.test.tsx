// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { PanelHeader } from './PanelHeader';

/**
 * En-tête du panneau : confidentialité seule, ou pastilles des éditeurs quand
 * d'autres sont présents ; date d'enregistrement, « À l'instant » pendant une
 * minute ; bouton Enregistrer en icône seule dont le nom dit l'état.
 */

type Props = Parameters<typeof PanelHeader>[0];

let view: RenderedComponent | null = null;

function render(props: Partial<Props> = {}) {
  view = renderComponent(createElement(PanelHeader, {
    title: 'Peter Pan',
    savedAt: '2026-04-09T07:33:00.000Z',
    sizeBytes: 2048,
    privacy: 'private',
    onBack: vi.fn(),
    onSave: vi.fn(),
    onShare: vi.fn(),
    ...props,
  }));
  return view.container;
}

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

describe('PanelHeader', () => {
  it('affiche la confidentialité tant que personne d’autre n’est là', () => {
    const root = render({ collaborators: [{ userId: 'me', name: 'Moi', isSelf: true }] });
    expect(root.querySelector('.rvi-header__privacy')?.textContent).toBe('Privé');
    expect(root.querySelector('.rvi-header__people')).toBeNull();
  });

  it('remplace la confidentialité par les pastilles des éditeurs présents', () => {
    const root = render({
      collaborators: [
        { userId: 'me', name: 'Moi', isSelf: true },
        { userId: 'a', name: 'Alice' },
        { userId: 'b', name: 'Bob' },
        { userId: 'c', name: 'Chloé' },
      ],
    });
    expect(root.querySelector('.rvi-header__privacy')).toBeNull();
    // 3 places : deux pastilles + « +2 ».
    const full = root.querySelector('.rvi-header__people-full');
    expect(full?.querySelectorAll('.rv-avatar').length).toBe(2);
    expect(full?.querySelector('.rv-avatar-stack__more')?.textContent).toBe('+2');
  });

  it('montre la date d’un ancien enregistrement, la taille en infobulle', () => {
    const root = render();
    const saved = root.querySelector('.rvi-header__saved');
    expect(saved?.textContent).toMatch(/^\d{2}:\d{2} - 09\/04\/2026$/);
    expect(saved?.getAttribute('title')).toContain('2ko');
  });

  it('dit « À l’instant » pendant une minute après un enregistrement', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T10:00:30.000Z'));
    const root = render({ savedAt: '2026-10-08T10:00:00.000Z' });
    expect(root.querySelector('.rvi-header__saved')?.textContent).toBe('À l’instant');
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(root.querySelector('.rvi-header__saved')?.textContent).toMatch(/^\d{2}:\d{2} - 08\/10\/2026$/);
  });

  it('donne au bouton Enregistrer l’état en nom accessible', () => {
    const onSave = vi.fn();
    const root = render({ onSave, saveStatus: 'pending' });
    const button = root.querySelector<HTMLButtonElement>('button.rvi-header__save');
    expect(button?.getAttribute('aria-label')).toBe('Synchronisation en attente');
    act(() => button?.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
