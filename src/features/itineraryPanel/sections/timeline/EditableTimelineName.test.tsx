// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import type { TimelineItem } from '../../types';
import { EditableTimelineName } from './EditableTimelineName';

/**
 * Nom d'un POI dans la feuille de route : un clic ouvre la saisie, Entrée /
 * perte du focus valident, Échap annule.
 */

const bakery: TimelineItem = { id: 'poi-1', kind: 'poi', label: 'La Mie Câline', distanceKm: 12, poiCategory: 'bakeries', osmId: 1 };

let view: RenderedComponent | null = null;

function render() {
  const onRename = vi.fn<(id: string, label: string) => void>();
  view = renderComponent(createElement(EditableTimelineName, {
    item: bakery,
    className: 'rvi-tl-td__name',
    inputClassName: 'rvi-tl-td__name-input',
    onRename,
  }));
  return { view, onRename };
}

function input(): HTMLInputElement {
  const found = view?.container.querySelector<HTMLInputElement>('input');
  if (!found) throw new Error('champ de saisie absent');
  return found;
}

function type(value: string) {
  act(() => {
    const field = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('EditableTimelineName', () => {
  it('clic → saisie ; Entrée enregistre le nouveau nom', () => {
    const { view, onRename } = render();
    const name = view.container.querySelector<HTMLElement>('.rvi-tl-td__name')!;
    expect(name.className).toContain('rvi-tl-td__name--editable');
    view.click(name);
    expect(input().value).toBe('La Mie Câline');
    type('7-19 La Mie');
    press('Enter');
    expect(onRename).toHaveBeenCalledWith('poi-1', '7-19 La Mie');
    expect(view.container.querySelector('input')).toBeNull();
  });

  it('Échap annule sans rien enregistrer', () => {
    const { view, onRename } = render();
    view.click(view.container.querySelector('.rvi-tl-td__name')!);
    type('Autre nom');
    press('Escape');
    expect(onRename).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe('La Mie Câline');
  });

  it('nom inchangé : rien n’est enregistré ; nom vidé : retour au nom d’origine demandé', () => {
    const { view, onRename } = render();
    view.click(view.container.querySelector('.rvi-tl-td__name')!);
    press('Enter');
    expect(onRename).not.toHaveBeenCalled();
    view.click(view.container.querySelector('.rvi-tl-td__name')!);
    type('');
    press('Enter');
    expect(onRename).toHaveBeenCalledWith('poi-1', '');
  });
});
