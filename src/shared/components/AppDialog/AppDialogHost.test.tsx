// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { confirmDialog, promptDialog } from '@/shared/lib/appDialog';
import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';

import { AppDialogHost } from './AppDialogHost';

/**
 * Pop-ins de confirmation / saisie à la place de window.confirm / prompt :
 * réponse par le bouton principal, Annuler, Échap ou un clic à côté ; les
 * touches tapées dedans ne remontent jamais à la page (Échap d'une pop-in
 * dessous, raccourcis de la carte) ; une pop-in à la fois ; focus rendu.
 */

let view: RenderedComponent | null = null;

beforeEach(() => {
  view = renderComponent(createElement(AppDialogHost));
});

afterEach(() => {
  view?.unmount();
  view = null;
});

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const buttonByText = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === text) ?? null;

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
}

const confirmOptions = { title: 'Supprimer « Tour » ?', message: 'Le projet sera supprimé définitivement.', confirmLabel: 'Supprimer' };

describe('confirmDialog', () => {
  it('fermée tant que rien n’est demandé', () => {
    expect(dialog()).toBeNull();
  });

  it('titre, message décrit, modale ; le bouton principal répond vrai et ferme', async () => {
    const answer = confirmDialog(confirmOptions);
    await flush();
    const card = dialog()!;
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent).toBe('Supprimer « Tour » ?');
    expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('Le projet sera supprimé définitivement.');
    expect(buttonByText('Annuler')).not.toBeNull();
    act(() => buttonByText('Supprimer')!.click());
    await expect(answer).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it('Annuler, Échap ou un clic à côté répondent faux', async () => {
    const byCancel = confirmDialog({ ...confirmOptions, cancelLabel: 'Garder' });
    await flush();
    act(() => buttonByText('Garder')!.click());
    await expect(byCancel).resolves.toBe(false);

    const byEscape = confirmDialog(confirmOptions);
    await flush();
    press(dialog()!, 'Escape');
    await expect(byEscape).resolves.toBe(false);

    const byScrim = confirmDialog(confirmOptions);
    await flush();
    act(() => { document.body.querySelector('.rv-dialog')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await expect(byScrim).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  it('les touches tapées dans la pop-in ne remontent pas à la page', async () => {
    const seen: string[] = [];
    const onDocument = (event: KeyboardEvent) => seen.push(`document:${event.key}`);
    const onWindow = (event: KeyboardEvent) => seen.push(`window:${event.key}`);
    document.addEventListener('keydown', onDocument);
    window.addEventListener('keydown', onWindow);
    try {
      const answer = confirmDialog(confirmOptions);
      await flush();
      press(buttonByText('Annuler')!, 'c');
      press(buttonByText('Annuler')!, 'Escape');
      await expect(answer).resolves.toBe(false);
      expect(seen).toEqual([]);
    } finally {
      document.removeEventListener('keydown', onDocument);
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('Échap avec le focus hors de la pop-in ferme cette pop-in seulement', async () => {
    let closedBelow = 0;
    const onWindow = (event: KeyboardEvent) => { if (event.key === 'Escape') closedBelow += 1; };
    window.addEventListener('keydown', onWindow);
    try {
      const answer = confirmDialog(confirmOptions);
      await flush();
      const event = press(document.body, 'Escape');
      await expect(answer).resolves.toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(closedBelow).toBe(0);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('une pop-in à la fois : la suivante attend la réponse à la première', async () => {
    const first = confirmDialog({ ...confirmOptions, title: 'Première' });
    const second = confirmDialog({ ...confirmOptions, title: 'Seconde' });
    await flush();
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain('Première');
    act(() => buttonByText('Supprimer')!.click());
    await expect(first).resolves.toBe(true);
    await flush();
    expect(dialog()!.textContent).toContain('Seconde');
    act(() => buttonByText('Annuler')!.click());
    await expect(second).resolves.toBe(false);
  });

  it('question devenue sans objet (signal) : la pop-in se ferme, ou ne s’ouvre jamais, et vaut Annuler', async () => {
    const shown = new AbortController();
    const queued = new AbortController();
    const first = confirmDialog({ ...confirmOptions, title: 'Première' }, { signal: shown.signal });
    const second = confirmDialog({ ...confirmOptions, title: 'Seconde' }, { signal: queued.signal });
    const third = confirmDialog({ ...confirmOptions, title: 'Troisième' });
    await flush();
    queued.abort();
    await expect(second).resolves.toBe(false);
    expect(dialog()!.textContent).toContain('Première');
    shown.abort();
    await expect(first).resolves.toBe(false);
    await flush();
    expect(dialog()!.textContent).toContain('Troisième');
    act(() => buttonByText('Annuler')!.click());
    await third;

    const already = new AbortController();
    already.abort();
    await expect(promptDialog({ title: 'x', label: 'y', confirmLabel: 'z' }, { signal: already.signal })).resolves.toBeNull();
    await flush();
    expect(dialog()).toBeNull();
  });

  it('rend le focus à l’élément qui l’avait', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const answer = confirmDialog(confirmOptions);
      await flush();
      act(() => buttonByText('Annuler')!.click());
      await answer;
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });
});

describe('promptDialog', () => {
  const promptOptions = { title: 'Renommer le projet', label: 'Nom du projet', initialValue: 'Tour', confirmLabel: 'Renommer' };

  it('valeur initiale, champ étiqueté, texte saisi rendu sans espaces autour', async () => {
    const answer = promptDialog(promptOptions);
    await flush();
    const input = dialog()!.querySelector('input')!;
    expect(input.value).toBe('Tour');
    expect(input.closest('label')?.textContent).toContain('Nom du projet');
    type(input, '  Tour du Mont-Blanc  ');
    act(() => buttonByText('Renommer')!.click());
    await expect(answer).resolves.toBe('Tour du Mont-Blanc');
  });

  it('nom vide : bouton principal désactivé ; Annuler rend null', async () => {
    const answer = promptDialog(promptOptions);
    await flush();
    type(dialog()!.querySelector('input')!, '   ');
    expect(buttonByText('Renommer')!.disabled).toBe(true);
    act(() => buttonByText('Annuler')!.click());
    await expect(answer).resolves.toBeNull();
  });
});
